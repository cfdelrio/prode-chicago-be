# Notificaciones — Documento técnico

Documento orientado a desarrolladores. Describe **cómo** está implementado el sistema de notificaciones de ProdeCaballito: arquitectura, módulos, queries, triggers y trade-offs.

Para el **qué y cuándo** de cada notificación, ver [FUNCTIONAL.md](./FUNCTIONAL.md).

---

## 1. Arquitectura de alto nivel

```
                ┌──────────────────────┐
                │   EventBridge cron   │
                │   (every 5 min)      │
                └──────────┬───────────┘
                           │ source: prode.*
                           ▼
              ┌────────────────────────┐         ┌────────────┐
              │  Lambda prode-api      │────────▶│  RDS / PG  │
              │  (event handler)       │         │ notif tbl  │
              └─────┬────────────┬─────┘         └────────────┘
                    │            │
            ┌───────▼──┐    ┌────▼────┐    ┌──────────┐
            │ Web Push │    │ Infobip │    │  Twilio  │
            │  (VAPID) │    │  (SMS)  │    │ (WhatsApp│
            └──────────┘    └─────────┘    │/templates)│
                                           └──────────┘
```

- Cron EventBridge dispara la Lambda con distintos `event.source`.
- La Lambda lee la DB, decide a quién notificar, ejecuta envíos en paralelo y persiste el historial.
- Cada canal externo es **best-effort**: una falla loguea pero no rompe el batch.

---

## 2. Modelo de datos

### Tabla `notifications`

Historial in-app. Una fila por evento por usuario.

| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | uuid PK | |
| `user_id` | uuid FK users | |
| `match_id` | uuid FK matches NULL | Opcional, contexto |
| `type` | text | `kickoff`, `second_half`, `bet_reminder`, `cutoff_reminder`, `result`, `ranking_change`, `ranking`, etc. |
| `payload` | jsonb | `{ title, body, icon, ... }` |
| `status` | text | `pending` / `sent` / `read` / `failed` |
| `sent_at` | timestamptz NULL | |
| `created_at` | timestamptz | |

**Payload contract:** todos los generadores usan keys `title` y `body` (no `titulo`/`mensaje` — convención unificada).

### Tabla `bet_reminders`

Opt-in del usuario: "avisame N minutos antes del partido X".

| Columna | Notas |
|---------|-------|
| `id`, `user_id`, `match_id`, `planilla_id` | FKs |
| `remind_minutes` | int (5/10/15/30/60) |
| `scheduled_for` | `match.start_time − remind_minutes` |
| `email_sent` | bool — **se usa como flag "sent" para todos los canales** (legacy naming) |
| `sent_at` | timestamptz NULL |

### Tabla `reminder_sent`

Idempotency key para `cutoff_reminder`. Constraint `UNIQUE (user_id, match_id, reminder_type)`.

### Tabla `scheduled_jobs`

Kickoff / second-half jobs. `UNIQUE (match_id, job_type)`. Status: `pending` → `completed`.

### Tabla `push_subscriptions`

PWA web push subs. `id` (autoincrement), `user_id`, `endpoint`, `p256dh`, `auth`.

---

## 3. Módulos del backend

```
services/
  push.js                ← Web Push helpers (sendPush, pushToUser, pushToAll)
  sms.js                 ← Infobip (sendSMS, sendSMSWithRetry, SMS_WHITELIST)
  whatsapp.js            ← Twilio (sendWhatsApp, sendWhatsAppTemplate, TEMPLATES)
  betReminders.js        ← processBetReminders() — opt-in pre-kickoff
  reminderCutoff.js      ← runCutoffReminders() — pre-cierre del torneo
  resultNotifications.js ← notifyResult() — post-resultado (email, sms, push, in-app)
  email.js               ← SES senders (digest, ranking, leader, result, reminder)
workers/
  schedulerService.js    ← processPendingJobs() — kickoff / second_half
  notificationService.js ← crearNotificacion + generarNotificacionKickoff
routes/
  notifications.js       ← REST (GET, POST, mark-read, delete, unread-count)
  matches.js             ← actualizarRanking() — dispara ranking_change in-app
  admin.js               ← broadcasts manuales
```

---

## 4. Triggers (EventBridge → Lambda)

`lambda.js` despacha por `event.source`:

| Source | Handler | Cron |
|--------|---------|------|
| `prode.reminder-cutoff` | `runCutoffReminders()` | `cron(*/5 * * * ? *)` |
| `prode.process-jobs` | `schedulerService.processPendingJobs()` + `processBetReminders()` | `cron(*/5 * * * ? *)` |
| `prode.weekly` | `sendWeeklyEmailBatch()` | semanal |
| `prode.voice-survey` | `runVoiceSurvey()` | on-demand |
| `prode.set-winner` | upsert config `ganador_fecha` | on-demand |
| `prode.upcoming-cutoffs` | dry-run / debug | on-demand |
| `winner-notification` | `processWinnerNotification()` (invoke async) | invocado por matchdays |

> El endpoint `POST /api/matches/:id/result` dispara `notifyResult` **inline** (await dentro del request) antes de `res.json`. Razón: en serverless-http, `res.json()` congela el container y trabajo posterior se pierde.

---

## 5. Flujos detallados

### 5.1 `cutoff_reminder` — `services/reminderCutoff.js`

```text
cron 5min → runCutoffReminders()
  ├─ SELECT tournaments con primer match en (NOW+20m, NOW+40m)
  ├─ For each torneo en ventana:
  │    SELECT usuarios con planilla en el torneo + bets faltantes
  │    (JOIN users para whatsapp_number/consent — un solo query, no N+1)
  │    For each usuario:
  │      INSERT reminder_sent ON CONFLICT DO NOTHING RETURNING
  │      └─ si conflict → skip (ya notificado)
  │      pushToUser(...)         ← .catch logs
  │      sendSMSWithRetry(...)   ← retry 1s/2s/4s en 5xx, no en 4xx
  │      INSERT notifications (type='cutoff_reminder', status='sent')
  └─ For each standalone match (sin tournament_id, con planilla_id):
       SELECT planilla específica del match — NO todas las planillas
       (fix de bug 2026-05: antes notificaba a usuarios sin relación)
       Mismo flujo: reminder_sent + push + sms + notifications
```

**Idempotency:** `reminder_sent` (UNIQUE per user/match/type). El `INSERT … ON CONFLICT DO NOTHING RETURNING` actúa como lock: si devuelve 0 rows, otra invocación ya envió.

**Edge cases:**
- Si la query `INSERT notifications` falla, el flujo sigue (logged). No revierte el push/SMS.
- Si push y SMS fallan, el `reminder_sent` quedó pero el usuario no recibió nada → próxima corrida no reintenta (consciente: evitar duplicados es prioritario).

### 5.2 `bet_reminder` — `services/betReminders.js`

```text
prode.process-jobs → processBetReminders()
  SELECT * FROM bet_reminders WHERE email_sent=false
    AND scheduled_for <= NOW()
    AND match.estado='scheduled'
    LIMIT 200
    JOIN matches, users, LEFT JOIN bets (para mostrar el pronóstico)
  For each row:
    pushToUser(...) .catch logs
    sendSMSWithRetry(...) .catch logs
    INSERT notifications (type='bet_reminder', status='sent')
    UPDATE bet_reminders SET email_sent=true, sent_at=NOW()
```

**`LIMIT 200`:** evita que un backlog enorme bloquee la Lambda. Se procesa lo más viejo primero (`ORDER BY scheduled_for ASC`).

**No retry global:** si push/SMS fallan, el row queda marcado como `email_sent=true`. El retry está adentro de `sendSMSWithRetry` (3 intentos para 5xx).

### 5.3 `kickoff` / `second_half` — `workers/schedulerService.js`

```text
prode.process-jobs → schedulerService.processPendingJobs()
  SELECT scheduled_jobs WHERE status='pending' AND scheduled_for <= NOW() LIMIT 100
  For each job:
    SELECT betters (users que apostaron + sus pronósticos via MIN(goles_local/visitante))
    For each user:
      generarNotificacionKickoff()  ← INSERT notifications (type='kickoff'/'second_half')
      pushToUser(...)               ← incluye el pronóstico en el body
      sendSMSWithRetry(...)         ← idem
    UPDATE scheduled_jobs SET status='completed'
```

**Por qué `MIN(goles_local)` en la query de betters:** un usuario puede tener varias planillas con el mismo match. El `GROUP BY u.id` colapsa, pero necesitamos un valor — `MIN` da una respuesta determinista. Si quisiéramos notificar por planilla deberíamos no agrupar.

### 5.4 `result_published` — `routes/matches.js` + `services/resultNotifications.js`

```text
POST /api/matches/:id/result (admin)
  ├─ guardar prevLeader (SELECT WHERE position=1)
  ├─ UPDATE matches SET resultado_*, estado='finished'
  ├─ calcular scores (calcularPuntaje) + INSERT ... ON CONFLICT UPDATE
  ├─ actualizarRanking()
  │    ├─ snapshot prev (Map planilla_id → {position, user_id, ...})
  │    ├─ INSERT/UPDATE ranking con SUM/COUNT FILTER (m.estado='finished')
  │    │   ← FILTER previene scores huérfanos contar en el ranking
  │    ├─ UPDATE position vía ROW_NUMBER() solo para planillas pagadas
  │    └─ For each cambio prev≠new:
  │         sendRankingUpdateEmail(...)
  │         if new.position != null:
  │           INSERT notifications (type='ranking_change',
  │             payload = buildRankingChangePayload({prev, new, planillaNombre}))
  ├─ recalculateTournamentRanking() + recalcMatchdayForMatch()
  └─ notifyResult({ match, resultLocal, resultVisitante, bets, prevLeader })
       ├─ _notifyNewLeader   ← email + push + sms + INSERT notifications
       ├─ _notifyBetResults  ← email + sms + INSERT notifications (por usuario con bet)
       ├─ _pushBroadcast     ← pushToAll
       └─ _notifyAdmins      ← SMS a admins con whatsapp_number
```

**`actualizarRanking` está dentro del try/await del endpoint:** bloquea la response. Trade-off: simplicidad > latencia. Las queries son O(N planillas) y N es chico (~50).

---

## 6. SMS retry (`services/sms.js`)

```javascript
sendSMSWithRetry({ to, body, maxAttempts = 3 })
  // backoff: 1s, 2s, 4s — configurable via SMS_RETRY_BASE_MS
  // retry SOLO en 5xx; 4xx (mal número) lanza inmediatamente
```

**Por qué:** Infobip ocasionalmente devuelve 503. Antes del retry, se perdía silenciosamente el SMS y `email_sent=true` se quedaba mintiendo.

**En tests:** `SMS_RETRY_BASE_MS=0` salta el sleep (sin esto cada test demoraría 7s en el peor caso).

---

## 7. Web Push (`services/push.js`)

- VAPID keys via env (`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`). Fallback hardcoded para dev.
- `sendPush` borra automáticamente subs con 410/404 (`push_subscriptions WHERE endpoint = $1`).
- `pushToUser(userId, payload)` itera todas las subs del usuario.
- `pushToAll(payload)` usa **keyset pagination**:
  ```sql
  -- batch 1
  SELECT * FROM push_subscriptions ORDER BY id ASC LIMIT $1
  -- batch N+1
  SELECT * FROM push_subscriptions WHERE id > $last_id ORDER BY id ASC LIMIT $1
  ```
  Tamaño configurable: `PUSH_BROADCAST_BATCH` (default 100). Razón: evitar cargar toda la tabla en memoria de Lambda.

---

## 8. Idempotency y consistencia

| Notificación | Mecanismo |
|--------------|-----------|
| `cutoff_reminder` | `reminder_sent` con `UNIQUE(user_id, match_id, reminder_type)` |
| `bet_reminder` | `bet_reminders.email_sent` flag |
| `kickoff` / `second_half` | `scheduled_jobs.status = 'pending' → completed` |
| `ranking_change` | Disparado solo cuando `prevPos !== newPos` |
| `result_published` (in-app) | Idempotente por la naturaleza del trigger (un `POST /result` único) |

> **No hay transacción que cubra "send + mark"**. Si el INSERT/UPDATE de "sent" falla **después** de enviar push/SMS, el próximo cron podría reenviar. Decisión consciente: en la práctica el INSERT falla rarísimo, y los costos de orquestación distribuida superan al beneficio.

---

## 9. Whitelists y feature flags

| Env var | Efecto |
|---------|--------|
| `WHATSAPP_ENABLED=false` | Apaga TODOS los envíos de Twilio WhatsApp |
| `WHATSAPP_WHITELIST=+54...,+54...` | Solo manda WA a esos números |
| `SMS_WHITELIST=+54...,+54...` | Solo manda SMS a esos números |
| `PUSH_BROADCAST_BATCH=100` | Tamaño del batch en `pushToAll` |
| `SMS_RETRY_BASE_MS=1000` | Base del backoff (0 en tests) |
| `INFOBIP_API_KEY` / `INFOBIP_BASE_URL` / `INFOBIP_SMS_FROM` | Credenciales Infobip |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_WHATSAPP_FROM` | Credenciales Twilio |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Claves web push |

---

## 10. Tests

```
__tests__/
  betReminders.test.js          ← 7 tests del processBetReminders
  reminderCutoff.test.js        ← 14 tests (tournament + standalone + payload + edge cases)
  schedulerService.test.js      ← 7 tests del processPendingJobs
  notificationService.payload.test.js ← contrato del payload (title/body, no titulo/mensaje)
  rankingChangePayload.test.js  ← 5 tests del helper (entrada, subida, bajada, singular/plural)
  pushToAll.test.js             ← 4 tests de la paginación keyset
  sms.infobip.test.js           ← sendSMS + sendSMSWithRetry (retry 5xx, no-retry 4xx, agotar)
  rankingOrphans.test.js        ← regression guard (scores huérfanos no cuentan)
  matchdayWinner.test.js        ← processWinnerNotification (lambda async invoke)
```

Total: 268 tests al momento de redactar este doc.

---

## 11. Decisiones técnicas y trade-offs registrados

### 11.1 ¿Por qué Infobip + Twilio?
Twilio WhatsApp requiere templates aprobados por Meta para mensajes fuera de la ventana de 24h. Para recordatorios automáticos eso es prohibitivo. Infobip SMS no tiene esa limitación. WhatsApp queda para casos donde el template está aprobado (nuevo líder, resultado, ganador, broadcasts).

### 11.2 ¿Por qué cron cada 5 min y no scheduling fino?
EventBridge tiene granularidad 1 min mínimo y el costo se dispara. 5 min es buen balance: latencia worst-case 4:59 min, queries livianas, idempotency cubre las superposiciones.

### 11.3 ¿Por qué la notificación in-app de resultados se hace inline en `_notifyBetResults` y no via `generarNotificacionResultado`?
Históricamente había una función dedicada que nunca se llamaba (código muerto, removido en PR #87). El flujo "real" usa `INSERT INTO notifications` directo dentro de `_notifyBetResults` porque ya tiene todo el contexto del partido y la apuesta.

### 11.4 ¿Por qué `email_sent` se usa como flag para todos los canales en `bet_reminders`?
Legacy naming. Originalmente solo había email. Cuando se sumaron push y SMS, se reusó el flag para no migrar el schema. Documentado en el código.

### 11.5 ¿Por qué `actualizarRanking` bloquea la response del POST /result?
`serverless-http` congela el Lambda al `res.json()`. `setImmediate` o `process.nextTick` no garantizan ejecución antes del congelamiento. La alternativa correcta sería `lambda.invoke async`, pero la latencia adicional del recálculo (~200ms) era aceptable y se priorizó simplicidad.

---

## 12. Cómo agregar un nuevo tipo de notificación

1. **Definir el trigger:** ¿es por cron, por endpoint admin, por evento de DB?
2. **Decidir canales:** push, SMS, email, in-app.
3. **Agregar al INSERT en `notifications`** con `type='nuevo_tipo'` y `payload={ title, body, icon }`.
4. **Tests:** unit del payload builder + integration que mockea `db.query`, `pushToUser`, `sendSMSWithRetry`.
5. **Documentar:** agregarlo en [FUNCTIONAL.md](./FUNCTIONAL.md) sección 2 + en este doc sección 5.

Patrón recomendado: builder puro `buildPayload({...})` → testeable aislado.
