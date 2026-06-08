# Integración con Orkest AI — Central multi-canal de notificaciones

> **Estado:** documento de referencia. La integración todavía no está implementada.
> **Audiencia:** cualquier Claude o desarrollador que vaya a diseñar / implementar el conector ProdeCaballito ↔ Orkest.
> **Panel de Orkest:** https://engage.orkestai.ar/voice-campaigns

---

## 1. Resumen ejecutivo

ProdeCaballito hoy hace **fan-out propio**: cada trigger arma su payload para cada canal y llama directo al proveedor (Resend, Web Push, Infobip, Twilio). Eso genera:

- Código duplicado en cada servicio (`services/email.js`, `push.js`, `sms.js`, `whatsapp.js`, `voiceSurvey.js`).
- Reglas de canal/consent/whitelist regadas por todo el repo.
- Templating Argentina-deportivo hardcodeado en JS — difícil de iterar sin deploy.

**Modelo objetivo con Orkest:**

```
                      ┌─────────────────────────┐
ProdeCaballito  ──►   │ Orkest (central canal)  │ ──► Push / Email / SMS / WhatsApp / Voice
(publica EVENTOS      │ - decide canal          │
 de negocio)          │ - aplica template       │
                      │ - respeta consent       │
                      │ - retry / deliverability│
                      │ - delivery webhook ──┐  │
                      └──────────────────────┼──┘
                                             ▼
                            ProdeCaballito actualiza `notifications.status`
```

**Qué cambia:** desaparece el fan-out propio. Cada trigger pasa a hacer una sola llamada `orkest.publishEvent(eventType, payload)`.

**Qué NO cambia:**
- La lógica de negocio (cuándo se dispara un trigger, segmentación por posición).
- La idempotencia (`reminder_sent`).
- El scheduling (cron cada 5 min, ventanas, jobs EventBridge).
- El historial in-app (tabla `notifications`, endpoint `GET /api/notifications`, drawer del frontend).
- El IVR inbound de Twilio (0800) — sigue siendo Twilio porque Orkest está orientado a outbound.

---

## 2. Inventario de canales actuales

| Canal | Proveedor | Env vars | Entry-point | Archivo |
|-------|-----------|----------|-------------|---------|
| **Email** | Resend (no SES — `FUNCTIONAL.md` está desactualizado) | `RESEND_API_KEY` | `sendEmail({ to, subject, html })` + `send*Email()` wrappers | `services/email.js` |
| **Push (PWA)** | Web Push API | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | `sendPush(sub, payload)`, `pushToUser(userId, payload)`, `pushToAll(payload)` | `services/push.js` |
| **SMS** | Infobip | `INFOBIP_API_KEY`, `INFOBIP_BASE_URL`, `INFOBIP_SMS_FROM`, `SMS_WHITELIST`, `SMS_RETRY_BASE_MS` | `sendSMSWithRetry({ to, body, maxAttempts })` | `services/sms.js` |
| **WhatsApp** | Twilio + templates Meta | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `WHATSAPP_ENABLED`, `WHATSAPP_WHITELIST` | `sendWhatsApp({ to, body })`, `sendWhatsAppTemplate({ to, templateName, variables })` | `services/whatsapp.js` |
| **Voice (TTS outbound)** | Twilio (voz `Polly.Conchita` es-AR) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VOICE_FROM` | `runVoiceSurvey({ surveyId, question, options, userIds })` | `services/voiceSurvey.js` + TwiML en `routes/voice.js` |
| **Voice (IVR inbound 0800)** | Twilio | mismas vars | `POST /api/voice`, `/api/voice/menu` | `routes/voice.js` |
| **In-app** | Postgres | — | tabla `notifications` + `routes/notifications.js` | `routes/notifications.js` |

### WhatsApp templates pre-aprobados por Meta

| Slug | Twilio Content SID | Uso |
|------|--------------------|-----|
| `prode_nuevo_lider` | `HX3d2e4229b56b20d222ae85b64a2e607e` | Aviso de nuevo líder del ranking |
| `prode_resultado_partido` | `HX7ed5ef7d53402b094a81ecd8d4cbf5af` | Resultado publicado |
| `prode_ganador_fecha` | `HX037ab7e8789f1de1575a26737ff8a233` | Ganador de la fecha |

> **Importante para Orkest:** fuera de la ventana de 24h post-mensaje del usuario, WhatsApp **solo permite templates pre-aprobados por Meta**. Orkest debe soportar invocarlos por SID o crear los suyos equivalentes y mantenerlos aprobados.

---

## 3. Inventario de los 22 disparadores

Detalles completos de copies y condiciones: `docs/notifications/FUNCTIONAL.md` §2.1–2.12. Esta tabla es el índice maestro para mapearlos a eventos Orkest.

| # | Slug del tipo | Evento de negocio | Canales actuales | Archivo / función |
|---|---|---|---|---|
| 1 | `verification_code` | Alta de usuario / login con código | Email | `services/email.js` `sendVerificationCode()` |
| 2 | `welcome` | Confirmación de cuenta | Email | `services/email.js` `sendWelcomeEmail()` |
| 3 | `bet_reminder` | Opt-in del usuario al cargar apuesta (5/10/15/30/60 min antes) | Push + SMS + In-app | `services/betReminders.js` `processBetReminders()` |
| 4 | `cutoff_reminder` | 20–40 min antes de cierre del torneo, si quedan pronósticos pendientes | Push + SMS + In-app | `services/reminderCutoff.js` |
| 5 | `match_rescheduled` | Admin cambia `start_time` de un partido | Push + SMS + In-app | `routes/matches.js` `_notifyMatchRescheduled()` |
| 6 | `payment_pending` | Cron diario, planilla impaga, ≤7 días al inicio del torneo | Push + Email + SMS + In-app | `services/reminderPayment.js` |
| 7 | `kickoff` | `start_time` del partido | Push + SMS + In-app | `workers/schedulerService.js` |
| 8 | `second_half` | `start_time + 45 + halftime_minutes` | Push + SMS + In-app | `workers/schedulerService.js` |
| 9 | `result_published` (broadcast) | Admin publica resultado — push global con conteo de exactos | Push | `services/resultNotifications.js` `_pushBroadcast()` |
| 10 | `result_published` (individual) | Admin publica resultado — segmentado por exacto / ganador correcto / 0 pts | Push + Email + SMS + In-app | `services/resultNotifications.js` `_notifyBetResults()` |
| 11 | `new_leader` | Recálculo de ranking, cambio de líder | Push + Email + SMS + WhatsApp template + In-app | `services/resultNotifications.js` `_notifyNewLeader()` |
| 12 | `ranking_change` (entró) | Primera vez que entra al ranking | Push + In-app | `routes/matches.js` `buildRankingChangePayload()` |
| 13 | `ranking_change` (subió) | Recálculo, delta positivo, segmentado podio / remontada ≥5 / normal | Push + In-app | mismo |
| 14 | `ranking_change` (bajó) | Recálculo, delta negativo, segmentado último / severa / normal | Push + In-app | mismo |
| 15 | `ranking_passed` | Otro usuario lo sobrepasó | Push + In-app | `routes/matches.js` `actualizarRanking()` |
| 16 | `near_podio` | Gap ≤5 pts al puesto #3 | Push + In-app | `routes/matches.js` `actualizarRanking()` |
| 17 | `tournament_tomorrow` | Cron diario, torneo arranca mañana | Push + SMS + In-app | `services/reminderTournament.js` |
| 18 | `matchday_summary` | Cierre de fecha, segmentado por posición en la fecha (ganador/podio/medio/cola) | Push + Email + In-app | `routes/matchdays.js` `_notifyMatchdayClose()` |
| 19 | `personal_record` | Cierre de fecha, supera su mejor marca | Push + In-app | `routes/matchdays.js` |
| 20 | `streak_exactos` | Cierre de fecha, racha ≥3 / ≥6 / ≥9 exactos | Push + In-app | `routes/matchdays.js` |
| 21 | `winner` (ganador) | Cierre de fecha, mensaje épico al ganador | Push + Email + WhatsApp template | `routes/matchdays.js` `processWinnerNotification()` + `lambda.js` event `winner-notification` |
| 22 | `winner` (broadcast) | Cierre de fecha, anuncio al resto | Push | mismo |
| 23 | `weekly_digest` | Cron semanal EventBridge `prode.weekly`, segmentado por persona | Email | `routes/admin.js` `sendWeeklyEmailBatch()` + `services/email.js` `sendWeeklyEmail()` |
| 24 | `planilla_cierre` | Primer kickoff del torneo — backup de la planilla con marcas "—" en pronósticos faltantes | Email | `services/email.js` `sendPlanillaCierreEmail()` |
| 25 | `broadcast_manual` | Admin lo dispara desde panel | WhatsApp libre | `lambda.js` `POST /api/internal/broadcast-whatsapp` |
| — | `voice_survey` (outbound) | Admin lanza campaña | Voice (Twilio TTS) | `services/voiceSurvey.js` |
| — | IVR 0800 (inbound) | Usuario llama al 0800 | Voice (Twilio inbound) | `routes/voice.js` |

> **Para Orkest:** las dos últimas filas (voice survey outbound + IVR inbound) son las **únicas** que tocan voice hoy. La integración con `engage.orkestai.ar/voice-campaigns` reemplaza al menos la outbound. La inbound queda con Twilio salvo que Orkest la cubra explícitamente.

---

## 4. Modelo de evento propuesto para Orkest

ProdeCaballito publica **eventos semánticos sin copy**. Orkest aplica template, decide canal y respeta consent.

### Esquema base del payload

```json
{
  "event_type": "prode.result_published.individual",
  "idempotency_key": "result_published:user_42:match_1337",
  "occurred_at": "2026-05-21T18:30:00-03:00",
  "user": {
    "id": 42,
    "nombre": "Carlos",
    "email": "cfdelrio@gmail.com",
    "idioma_pref": "es",
    "tema_equipo": "river",
    "whatsapp_number": "+5491100000000",
    "whatsapp_consent": true,
    "push_subscriptions": [
      { "endpoint": "...", "p256dh": "...", "auth": "..." }
    ]
  },
  "business_context": {
    "match": { "id": 1337, "local": "Argentina", "away": "Brasil", "goles_local": 2, "goles_visitante": 1 },
    "bet":   { "goles_local": 2, "goles_visitante": 1, "puntos_obtenidos": 3, "bonus_aplicado": 0 },
    "ranking_after": { "position": 7, "delta": 3, "planilla_nombre": "Mi Planilla" },
    "outcome": "exacto"  // "exacto" | "ganador" | "cero"
  },
  "channels_hint": ["push", "email", "sms", "in_app"]
}
```

### `event_type` slugs sugeridos (uno por trigger)

```
prode.verification_code
prode.welcome
prode.bet_reminder
prode.cutoff_reminder
prode.match_rescheduled
prode.payment_pending
prode.kickoff
prode.second_half
prode.result_published.broadcast
prode.result_published.individual
prode.new_leader
prode.ranking_change.entered
prode.ranking_change.up
prode.ranking_change.down
prode.ranking_passed
prode.near_podio
prode.tournament_tomorrow
prode.matchday_summary
prode.personal_record
prode.streak_exactos
prode.winner.personal
prode.winner.broadcast
prode.weekly_digest
prode.planilla_cierre
prode.broadcast_manual
```

### `idempotency_key`

Generado por ProdeCaballito con el mismo criterio que `reminder_sent` hoy:

- `<event_type>:user_<userId>:match_<matchId>` (eventos de partido)
- `<event_type>:user_<userId>:matchday_<matchdayId>` (eventos de fecha)
- `<event_type>:user_<userId>:tournament_<tournamentId>` (eventos de torneo)
- `<event_type>:user_<userId>:planilla_<planillaId>` (eventos de planilla)

Orkest debe deduplicar con esta key — si lo recibe dos veces, el segundo es no-op.

### `channels_hint`

Lista de canales por los que **históricamente** se envió este trigger. Orkest la puede:
- ignorar (decide solo con su matriz canal/consent), o
- respetar como contrato mínimo durante la migración (para mantener paridad).

---

## 5. Consent, identidad y whitelists

| Canal | Cómo se obtiene consent | Campo / tabla | Default |
|-------|-------------------------|---------------|---------|
| Push (PWA) | Botón explícito en `/notificaciones` + permiso del browser | `push_subscriptions` (1 fila por device) | Off |
| SMS | Check "Quiero recibir avisos por SMS" + cargar número | `users.whatsapp_number` + `users.whatsapp_consent = true` | Off |
| WhatsApp | Mismo flag que SMS (`whatsapp_consent`) | idem | Off |
| Email | Implícito al alta (verificado por código vía `verification_code`) | `users.email` | On |
| Voice outbound | Hoy reusa `whatsapp_consent`. **Para Orkest hay que decidir si voice merece flag separado** | `users.whatsapp_consent` (proxy) | Off |
| In-app | No requiere — siempre se persiste en `notifications` | `notifications` | — |

### Revocación

- SMS / WhatsApp / Push: el usuario apaga el toggle en `/profile`.
- Email: unsubscribe individual (link en el footer).
- **Importante para Orkest:** debe consultar consent **al momento del envío**, no al recibir el evento. Si el usuario revoca entre la publicación del evento y el envío, Orkest debe respetar la revocación.

### Whitelists de sandbox

- `SMS_WHITELIST` (comma-separated, env var del backend) — solo envía SMS a estos números.
- `WHATSAPP_WHITELIST` (comma-separated) — solo envía WhatsApp a estos números.
- `WHATSAPP_ENABLED=false` — apaga **todo** envío WhatsApp.

> Orkest necesita un mecanismo equivalente (sandbox mode, allowlist global) para no quemar plata/cuota en pruebas. Idealmente configurable por canal y por evento.

---

## 6. Tablas DB relevantes

| Tabla | Propósito | Columnas clave |
|-------|-----------|----------------|
| `notifications` | Historial in-app, leído por el drawer del frontend | `id, user_id, match_id, type, payload (jsonb), status, created_at, sent_at` |
| `push_subscriptions` | Endpoints Web Push registrados por el browser | `id, user_id, endpoint, p256dh, auth` |
| `reminder_sent` | Idempotencia de recordatorios | `id, user_id, match_id, reminder_type, sent_at` |
| `bet_reminders` | Opt-in por partido (minutos personalizados) | `id, user_id, match_id, planilla_id, remind_minutes, scheduled_for, email_sent` |
| `voice_surveys` | Metadata de campañas voice | `id, question, options (jsonb), status, created_at, total_called` |
| `voice_survey_responses` | Respuestas digit | `survey_id, call_sid, phone_number, digit, call_status, created_at` |
| `users` | Identidad + consent + preferencias | `id, nombre, email, whatsapp_number, whatsapp_consent, idioma_pref, tema_equipo` |

### División de responsabilidades con Orkest

| Tabla | Sigue en ProdeCaballito | Delegada / espejo en Orkest |
|-------|-------------------------|-----------------------------|
| `notifications` | ✅ Sí (historial in-app es producto) | Orkest puede tener su log de envíos, pero la verdad para el usuario es esta tabla |
| `push_subscriptions` | ✅ Sí (Orkest las consume vía API o las recibe en el payload) | — |
| `reminder_sent` | ✅ Sí (idempotencia es lógica de negocio) | Orkest deduplica adicionalmente por `idempotency_key` |
| `voice_surveys` | ✅ Sí o se migra a Orkest entero | A definir — Orkest probablemente tiene su modelo de campaña |
| `users.whatsapp_consent` | ✅ Sí (consent es del producto) | Orkest consulta o recibe en cada evento |

---

## 7. Servicios y workers que hacen fan-out hoy

Estos son los **puntos a refactorizar** cuando se implemente el conector Orkest. El patrón actual es: el trigger arma N payloads (uno por canal) y llama N proveedores. La integración los reemplaza por una sola llamada `orkest.publishEvent(eventType, payload)`.

### Servicios de canal (a deprecar o adelgazar)

- `services/email.js` — Resend wrapper + `sendVerificationCode`, `sendWelcomeEmail`, `sendReminderEmail`, `sendResultEmail`, `sendRankingUpdateEmail`, `sendNewLeaderEmail`, `sendWeeklyEmail`, `sendPostMatchdayEmail`, `sendPlanillaCierreEmail`
- `services/push.js` — `sendPush`, `pushToUser`, `pushToAll`
- `services/sms.js` — `sendSMSWithRetry`
- `services/whatsapp.js` — `sendWhatsApp`, `sendWhatsAppTemplate`, `TEMPLATES`
- `services/voiceSurvey.js` — `runVoiceSurvey`

### Servicios de trigger (los que arman el payload por canal — adaptar para emitir evento Orkest)

- `services/betReminders.js`
- `services/reminderCutoff.js`
- `services/reminderPayment.js`
- `services/reminderTournament.js`
- `services/resultNotifications.js` — `_pushBroadcast`, `_notifyBetResults`, `_notifyNewLeader`, `_notifyAdmins`
- `workers/schedulerService.js` — kickoff / second_half
- `workers/notificationWorker.js`
- `routes/matches.js` — `buildRankingChangePayload`, `actualizarRanking`, `_notifyMatchRescheduled`
- `routes/matchdays.js` — `_notifyMatchdayClose`, `processWinnerNotification`
- `routes/admin.js` — `sendWeeklyEmailBatch`
- `lambda.js` — event handler `winner-notification`, endpoint `POST /api/internal/broadcast-whatsapp`

### Voice (caso especial)

- `routes/voice.js` (IVR inbound 0800) — **no se migra** salvo que Orkest cubra inbound. Twilio sigue manejando el 0800.
- `services/voiceSurvey.js` (outbound TTS) — **sí se migra** a `engage.orkestai.ar/voice-campaigns`.

---

## 8. Endpoints expuestos al frontend (no cambian con Orkest)

| Endpoint | Descripción | Quién consume |
|----------|-------------|---------------|
| `GET /api/notifications` | Historial in-app del usuario | Drawer |
| `POST /api/notifications` | Crear notificación in-app | Backend interno |
| `POST /api/notifications/send` | Broadcast admin | Admin panel |
| `GET /api/notifications/unread-count[-auth]` | Badge del icono campana | Header |
| `PUT /api/notifications/:id` | Marcar como leída / borrar | Drawer |
| `DELETE /api/notifications/:id` | Borrar | Drawer |
| `POST /api/push/subscribe` | Registrar Web Push subscription | Frontend |
| `DELETE /api/push/unsubscribe` | Cancelar Web Push | Frontend |
| `GET /api/push/vapid-public-key` | Bootstrap del browser para suscribirse | Frontend |
| `POST /api/internal/broadcast-whatsapp` | Admin manual broadcast | Admin panel |
| `POST /api/voice/*` | IVR inbound (Twilio webhooks) | Twilio |

### Webhook back de Orkest (nuevo, a diseñar)

Orkest necesita poder llamar a un endpoint **nuestro** cuando confirme delivery / failure de un envío, para que actualicemos `notifications.status` (`sent` → `read` lo hace el usuario al abrir el drawer; `failed` lo escribiría el webhook si Orkest reporta falla definitiva).

**Endpoint propuesto:** `POST /api/integrations/orkest/delivery-webhook`
- Payload: `{ idempotency_key, channel, status, provider_message_id, error? }`
- Auth: HMAC signature compartida (Orkest firma, nosotros verificamos)

---

## 9. Reglas operativas a preservar

Estas reglas son del producto, no del proveedor. Orkest debe respetarlas o ProdeCaballito las sigue ejecutando antes de publicar el evento.

1. **Idempotencia**: ningún evento se entrega dos veces al mismo usuario para el mismo trigger. Hoy se garantiza via `reminder_sent` (lado ProdeCaballito) + Orkest debe deduplicar por `idempotency_key`.
2. **Ventana de cutoff**: cron cada 5 min, ventana 20–40 min antes del cierre del torneo.
3. **Periodicidad**: una sola vez por evento de negocio (resultado publicado, fecha cerrada, etc.). Si el admin re-publica, no re-enviamos.
4. **Retries silenciosos**: Infobip 5xx → reintenta 3 veces con backoff exponencial (hoy `SMS_RETRY_BASE_MS=1000`). Web Push 410/404 → eliminar subscription. **Esto lo absorbe Orkest** cuando migremos.
5. **Tono argentino-deportivo** (CLAUDE.md): inspiración ESPN/TyC/Mundial. **Sin tono casino ni apuestas ilegales.** Si Orkest hace templating, los templates deben respetar este estilo.
6. **Segmentación por posición**: campeón / podio / zona caliente / pelotón. Hoy se calcula en ProdeCaballito antes del envío. Orkest puede recibirla ya calculada en `business_context` o calcularla con su motor.
7. **WhatsApp fuera de ventana 24h → solo templates Meta**. Lista en sección 2.
8. **WhatsApp templates**: solo `prode_nuevo_lider`, `prode_resultado_partido`, `prode_ganador_fecha` están pre-aprobados. Cualquier otro mensaje WhatsApp libre solo en ventana de 24h o vía template nuevo aprobado por Meta.
9. **Privacidad**: el `whatsapp_number` solo se muestra a otros usuarios si `whatsapp_consent = true`. Idem para Orkest.
10. **Internacionalización**: `users.idioma_pref` es `'es'` o `'pt'` — los templates deben tener variante. Hoy la mayoría está en es-AR.

---

## 10. Frontend consumer (no se entera del cambio)

| Archivo | Propósito |
|---------|-----------|
| `src/hooks/usePushNotifications.ts` | Opt-in flow, fetch de VAPID key, subscribe/unsubscribe |
| `public/sw.js` | Service worker — intercepta el push del browser y muestra notification nativa |
| `src/components/NotificationHistoryDrawer.tsx` | Drawer del icono campana — lee `/api/notifications`, tiene `ICON_MAP` por tipo |
| `src/hooks/useNotificationHistory.ts` | Paginación, mark-as-read |

**Importante:** el frontend sigue leyendo `/api/notifications` (historial in-app) y recibiendo Web Push por el endpoint registrado. **Si Orkest manda el Web Push, debe hacerlo al endpoint del browser** (el que ProdeCaballito le pasa en el payload del evento). El frontend no distingue origen.

---

## 11. Brechas / preguntas abiertas para la integración

Estas son las preguntas que hay que resolver con Orkest **antes** de implementar el conector.

1. **Web Push:** ¿Orkest acepta el formato Web Push API (endpoint + p256dh + auth) usando nuestras VAPID keys, o requiere device tokens nativos (FCM/APNs)? Hoy somos PWA-only, sin app nativa.
2. **WhatsApp templates:** ¿Orkest puede invocar templates Meta por SID propio (los 3 listados en sección 2) o requiere registrar templates nuevos a través de su cuenta? ¿Mantiene la aprobación Meta?
3. **Consent:** ¿ProdeCaballito sube la lista de usuarios consentidos por canal a Orkest (sync periódico) o Orkest hace pull vía API contra `/api/users/:id/consent`? Preferible push para no exponer endpoint.
4. **Segmentación:** ¿Orkest puede ejecutar lógica "if user.position <= 3 then template A else template B" o ProdeCaballito sigue armando segmentos y los pasa en `business_context.segment`?
5. **Delivery webhook:** ¿Orkest soporta firmar con HMAC y reintentar el webhook si responde 5xx? ¿Esquema de retry?
6. **Voice outbound:** ¿usa `users.whatsapp_number` (el único teléfono que tenemos) o pide un campo separado? ¿Soporta voz `Polly.Conchita es-AR` o solo voces propias?
7. **Voice inbound (IVR):** ¿el panel `engage.orkestai.ar/voice-campaigns` solo cubre outbound, o también puede recibir el 0800? Hoy `routes/voice.js` está acoplado a Twilio.
8. **SLA y retry:** ¿Orkest replica el comportamiento actual (SMS 5xx → 3 retries con backoff; Push 410 → cleanup subscription)? Si no, ¿qué garantías ofrece?
9. **Costos por canal y throttling:** límite de envíos por hora / día / canal. Hoy no tenemos throttling explícito — el `pushToAll` pagina en batches de `PUSH_BROADCAST_BATCH=100` pero sin rate limit.
10. **Sandbox / whitelist:** equivalente a `SMS_WHITELIST` / `WHATSAPP_WHITELIST` para QA sin gastar plata.
11. **Templating de copy:** ¿Orkest tiene editor de templates con variables (`{{nombre}}, {{points}}`) o hay que mandar el copy renderizado en cada evento? Si edita templates en su panel, perdemos versionado en git — evaluar.
12. **Estilo y revisión:** los copies tienen que ser ESPN/TyC, no casino. ¿Quién aprueba cada template en el panel Orkest antes de salir? ¿Workflow de review?
13. **Migración por canal:** orden sugerido — empezar por SMS (más caro, más simple) → Voice (lo que claramente Orkest cubre) → WhatsApp (cuidado con templates Meta) → Push → Email (último porque Resend funciona bien). Validar con Orkest.
14. **Inbound responses:** si Orkest recibe respuestas (responder SMS, digit en voice survey), ¿cómo nos las entrega? Hoy `routes/voice.js` `POST /response` recibe el digit. Orkest necesita su propio webhook para eso.
15. **Historial in-app:** ¿Orkest persiste el envío como una notificación en su lado, o ProdeCaballito sigue siendo dueño del registro en `notifications`? Probable híbrido: nosotros persistimos antes de publicar el evento, Orkest persiste su log de delivery aparte.

---

## 12. Referencias

- **Especificación funcional completa** (copies y reglas por tipo): `docs/notifications/FUNCTIONAL.md` §2.1–2.12
- **Detalles técnicos** (TypeScript types, schemas): `docs/notifications/TECHNICAL.md`
- **Backlog y propuestas pendientes**: `docs/notifications/IDEAS.md`
- **Estilo y reglas del proyecto**: `CLAUDE.md` raíz
- **Panel Orkest**: https://engage.orkestai.ar/voice-campaigns

---

## Apéndice — Discrepancia detectada

`docs/notifications/FUNCTIONAL.md` §1 dice que email usa **SES**, pero `services/email.js` usa **Resend** (`RESEND_API_KEY`). Este doc usa el código como fuente de verdad. Pendiente: corregir FUNCTIONAL.md en una próxima iteración (no es bloqueante para Orkest).
