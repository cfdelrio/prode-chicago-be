# Engage — Variables disponibles en templates

Esta doc lista **qué variables puede usar cada template en Engage** según lo que
ProdeCaballito envía en cada `sendEvent`. Mantenerla actualizada cada vez que
se agrega o modifica un trigger.

---

## ⚠️ IMPORTANTE — Sintaxis correcta de variables

Engage resuelve las variables `{{...}}` desde **dos scopes distintos**:

### 1. Datos del contacto → `{{user.<campo>}}`

Los datos del usuario (nombre, email, phone, tema_equipo, etc) viven en el
**contact store de Engage** (`user.metadata`). Se actualizan automáticamente
en cada evento (auto-upsert sincrónico) con lo que mandamos en
`metadata.user_contact` y `metadata.user_profile`.

```
{{user.nombre}}            ✅ FUNCIONA
{{user.email}}             ✅ FUNCIONA
{{user.phone}}             ✅ FUNCIONA
{{user.tema_equipo}}       ✅ FUNCIONA
{{user.planilla_nombre}}   ✅ FUNCIONA
```

### 2. Datos del evento → `{{business_context.<campo>}}`

Los datos específicos del evento (puntos sumados, match, prev_leader, etc)
solo existen durante ese disparo puntual. Viven en `payload.business_context`.

```
{{business_context.puntos}}             ✅ FUNCIONA
{{business_context.prev_leader_nombre}} ✅ FUNCIONA
{{business_context.match.local}}        ✅ FUNCIONA
```

### ❌ NO funciona

```
{{nombre}}              ❌ NO FUNCIONA (Engage busca en payload root, no existe)
{{tema_equipo}}         ❌ NO FUNCIONA (mismo motivo)
{{puntos}}              ❌ NO FUNCIONA (no llega como root del payload)
{{user_contact.nombre}} ❌ NO FUNCIONA (metadata.user_contact no es scope del template)
```

### Regla mnemónica

| Lo que querés | Usá |
|---|---|
| Algo del **usuario** (perfil/contacto) | `{{user.<campo>}}` |
| Algo del **evento** disparado ahora | `{{business_context.<campo>}}` |

---

## Cómo funciona el auto-upsert

Cuando PC manda un `sendEvent` con `metadata.user_contact` + `metadata.user_profile`,
Engage hace upsert **sincrónico** del contact store ANTES de procesar el evento:

```
PC → sendEvent(metadata.user_contact.nombre = "Juan Nuevo")
  └─ Engage upsert: user.metadata.nombre = "Juan Nuevo"  ◄── síncrono
     └─ worker procesa evento
        └─ template "Hola {{user.nombre}}" → "Hola Juan Nuevo" ✅
```

**Consecuencias:**
- Siempre mandar `metadata` completo en cada evento (es la fuente de verdad).
- El contact store se mantiene fresco automáticamente.
- Templates leen del contact store actualizado.

---

## Estructura del payload a Engage

```js
{
  type: 'prode.xxx',
  userId: '<uuid del user>',
  idempotencyKey: '<key dedupe>',
  payload: {
    business_context: { /* datos específicos del evento */ },
  },
  metadata: {
    user_contact: { /* canal + consent + idioma */ },
    user_profile: { /* atributos del perfil para personalización */ },
  },
}
```

**Engage internamente:**
1. `metadata.user_contact` + `metadata.user_profile` → upsert a `user.metadata.*`
2. `payload.business_context.*` → scope del template como `{{business_context.*}}`
3. `user.metadata.*` → scope del template como `{{user.*}}`

---

## Variables siempre disponibles (en TODOS los eventos)

Estos campos los manda `buildEngageMetadata(user)` en `utils/engageHelpers.js`
y quedan upserteados en `user.metadata.*`. Acceso desde templates: `{{user.<campo>}}`.

### Desde `metadata.user_contact` (upsert a `user.metadata`)

| Variable en template | Tipo | Descripción |
|---|---|---|
| `{{user.nombre}}` | string\|null | Nombre del user |
| `{{user.email}}` | string\|null | Email (también disponible como columna `user.email`) |
| `{{user.phone}}` | string\|null | WhatsApp E.164 (`+549...`) |
| `{{user.whatsapp_consent}}` | boolean | Si autorizó WhatsApp |
| `{{user.idioma_pref}}` | string | `'es-AR'` (default) o `'pt-BR'` |

### Desde `metadata.user_profile` (upsert a `user.metadata`)

| Variable en template | Tipo | Descripción |
|---|---|---|
| `{{user.tema_equipo}}` | string\|null | Equipo favorito (river, boca, etc) |
| `{{user.foto_url}}` | string\|null | URL del avatar |
| `{{user.fecha_registro}}` | ISO 8601\|null | `created_at` del user |
| `{{user.rol}}` | string | `'usuario'`, `'moderator'`, `'admin'` |
| `{{user.planilla_nombre}}` | string\|null | Nombre de la planilla activa |
| `{{user.planilla_id}}` | string\|null | UUID de la planilla |
| `{{user.tournament_name}}` | string\|null | Torneo en el que participa |
| `{{user.estado_pago}}` | boolean\|null | Si pagó la planilla |
| `{{user.current_streak}}` | number | Racha actual de exactos |
| `{{user.best_streak}}` | number | Mejor racha histórica |
| `{{user.badges_count}}` | number | Cantidad de logros desbloqueados |
| `{{user.ranking_position}}` | number\|null | Posición en ranking |
| `{{user.puntos_totales}}` | number\|null | Puntos totales acumulados |

> **No todos los call sites llenan todos los campos.** Los campos derivados
> (planilla, ranking, streak) solo aparecen en eventos donde esa info está
> cargada. Cuando no se pasa, el campo es `null` o `0` en el upsert.

---

## Variables específicas por evento (`business_context`)

Acceso desde templates: `{{business_context.<campo>}}`.

### 📧 `prode.verification_code`

Trigger: signup, reenvío de código.

| Variable en template | Tipo | Descripción |
|---|---|---|
| `{{business_context.code}}` | string | Código de 6 dígitos |
| `{{business_context.expiresIn}}` | number | Segundos hasta expirar (900) |

### 👋 `prode.welcome`

Trigger: registro completo.

Sin `business_context` específico — solo usa `{{user.*}}`.

### 🏆 `prode.new_leader`

Trigger: cambio de líder en ranking tras publicar resultado.

| Variable en template | Tipo | Descripción |
|---|---|---|
| `{{business_context.puntos}}` | number | Puntos del nuevo líder |
| `{{business_context.prev_leader_nombre}}` | string\|null | Nombre del líder anterior |
| `{{business_context.match.local}}` | string | Equipo local |
| `{{business_context.match.away}}` | string | Equipo visitante |
| `{{business_context.match.goles_local}}` | number | Goles local |
| `{{business_context.match.goles_visitante}}` | number | Goles visitante |

**Plus en `{{user.*}}`:** `planilla_nombre`, `planilla_id`, `ranking_position`, `puntos_totales`.

### 📊 `prode.result_published.individual`

Trigger: resultado publicado, una por bet.

| Variable en template | Tipo | Descripción |
|---|---|---|
| `{{business_context.match.local}}` (y `away`, `goles_local`, `goles_visitante`) | mixed | Datos del partido |
| `{{business_context.bet.goles_local}}` (y `goles_visitante`, `puntos_obtenidos`) | mixed | Datos de la apuesta del user |
| `{{business_context.ranking_after.position}}` | number | Posición después del recálculo |
| `{{business_context.outcome}}` | string\|null | `'exacto'`, `'resultado'`, o `null` |

**Plus en `{{user.*}}`:** `planilla_nombre`, `current_streak`, `best_streak`, `ranking_position`, `puntos_totales`.

### 📧 `prode.weekly_digest`

Trigger: cron semanal.

| Variable en template | Tipo | Descripción |
|---|---|---|
| `{{business_context.week_date}}` | string | Fecha formateada |
| `{{business_context.ranking_position}}` | number | Posición |
| `{{business_context.total_players}}` | number | Total jugadores |
| `{{business_context.points}}` | number | Puntos del user |
| `{{business_context.best_round}}` | string\|null | Texto "Fecha N" o null |
| `{{business_context.best_round_points}}` | number | Pts en mejor jornada |
| `{{business_context.diferencia_puntos}}` | number | Distancia al top 5 |
| `{{business_context.pending_bets}}` | number | Apuestas pendientes |
| `{{business_context.tight_match}}` | object\|null | Partido más reñido |
| `{{business_context.upcoming_matches}}` | array | Próximos 3 partidos |

### 📣 `prode.broadcast_manual`

Trigger: admin dispara desde Admin → tab WhatsApp.

| Variable en template | Tipo | Descripción |
|---|---|---|
| `{{business_context.message}}` | string | Mensaje libre del admin |

### 🎙️ `prode.voice_nuevo_lider`

Trigger: igual que `new_leader` pero por canal voice.

| Variable en template | Tipo | Descripción |
|---|---|---|
| `{{business_context.template}}` | string | `'Nuevo Lider Prode'` |
| `{{business_context.nuevo_lider}}` | string | Nombre del nuevo líder (= user) |
| `{{business_context.puntos}}` | number | Puntos |
| `{{business_context.prev_leader}}` | string\|null | Líder anterior |
| `{{business_context.match_name}}` | string | `"Local vs Away"` |

### 💥 `prode.voice_perfect_score`

Trigger: usuario acertó exacto.

| Variable en template | Tipo | Descripción |
|---|---|---|
| `{{business_context.template}}` | string | `'Exacto Prode'` |
| `{{business_context.home_team}}`, `{{business_context.away_team}}` | string | Equipos |
| `{{business_context.goles_local}}`, `{{business_context.goles_visitante}}` | number | Resultado |
| `{{business_context.puntos}}` | number | Puntos sumados (4) |
| `{{business_context.ranking_pos}}` | number | Posición después |

### 📊 `prode.voice_weekly_summary`

Trigger: bundle paralelo al weekly digest.

| Variable en template | Tipo | Descripción |
|---|---|---|
| `{{business_context.template}}` | string | `'Weekly Summary Prode'` |
| `{{business_context.week_date}}` | string | Fecha |
| `{{business_context.leader_nombre}}`, `{{business_context.leader_puntos}}` | mixed | Datos del líder |
| `{{business_context.ranking_position}}` | number | Posición del user |
| `{{business_context.total_players}}` | number | Total jugadores |
| `{{business_context.pending_bets}}` | number | Apuestas pendientes |

---

## Cómo cargar un template en Engage

1. Buscar el `event_type` exacto (ej `prode.new_leader`)
2. Decidir el canal (WhatsApp, Email, Voice, etc)
3. Usar la sintaxis correcta:
   - `{{user.<campo>}}` para datos del contacto/perfil
   - `{{business_context.<campo>}}` para datos del evento
4. Probar con un user de test y verificar la sustitución

## Ejemplo correcto de template WhatsApp para `prode.new_leader`

```
👑 *¡Sos el nuevo líder, {{user.nombre}}!*

Le sacaste el #1 a *{{business_context.prev_leader_nombre}}* con
_{{business_context.match.local}} {{business_context.match.goles_local}}–{{business_context.match.goles_visitante}} {{business_context.match.away}}_.

🔥 Tenés *{{business_context.puntos}} pts* en tu planilla _{{user.planilla_nombre}}_.

{{#if user.tema_equipo}}Como hincha de {{user.tema_equipo}}, sabés lo que es la presión.{{/if}}

¡No lo sueltes! 👉 https://prodecaballito.com/ranking
```

---

## Verificación empírica (confirmado con Engage)

| Test | Resultado |
|---|---|
| Auto-upsert sincrónico antes de procesar evento | ✅ Funciona |
| `{{user.nombre}}` resuelve a `user.metadata.nombre` | ✅ Funciona |
| `{{nombre}}` (sin prefijo) | ❌ Resuelve a `event.payload.nombre` → undefined |
| `{{business_context.puntos}}` | ✅ Funciona |
| Cambio en DB → próximo evento manda nuevo valor → contact store actualizado | ✅ Funciona |

Fuente: confirmación del equipo Engage (`delivery-scheduler.ts:141-150`, `events.ts:85-98`).

---

## Mantenimiento de esta doc

Cuando agregás un nuevo `sendEvent` o modificás un `business_context`,
actualizá la sección correspondiente. La doc es la fuente de verdad para
saber qué variables están disponibles antes de cargar un template en Engage.
