# Eventos Engage — ProdeCaballito

Referencia completa de todos los eventos que ProdeCaballito envía a Engage, con sus payloads exactos.

## Sintaxis de variables en templates

- **Perfil del contacto:** `{{user.nombre}}`, `{{user.email}}`, `{{user.phone}}`
- **Payload del evento:** `{{business_context.campo}}`
- **Perfil extendido:** `{{user.tema_equipo}}`, `{{user.planilla_nombre}}`

---

## 1. Autenticación y Onboarding

### `prode.verification_code`
**Trigger:** Usuario solicita código de verificación  
**Archivo:** `routes/auth.js:177, 261`  
**Canal sugerido:** Email, SMS

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.code` | string | `"482915"` |
| `business_context.expiresIn` | number | `900` |

**Idempotency:** `verification_code:{pendingId}`

---

### `prode.welcome`
**Trigger:** Usuario completa el registro (`/auth/complete-registration`)  
**Archivo:** `routes/auth.js:317`  
**Canal sugerido:** Email, WhatsApp

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| *(sin business_context)* | — | — |

Solo usa metadata del perfil: `{{user.nombre}}`, `{{user.email}}`, `{{user.tema_equipo}}`

**Idempotency:** `welcome:{userId}`

---

## 2. Recordatorios

### `prode.cutoff_reminder`
**Trigger:** 20–40 min antes del cierre del torneo, usuarios con pronósticos pendientes  
**Archivo:** `services/reminderCutoff.js:146, 231`  
**Canal sugerido:** Email, WhatsApp, SMS

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.tournament_name` | string | `"Mundial 2026 - Grupo A"` |
| `business_context.minutes_left` | number | `28` |
| `business_context.pending_bets` | number | `3` |
| `business_context.first_match.local` | string | `"Argentina"` |
| `business_context.first_match.away` | string | `"Arabia Saudita"` |

**Idempotency:** `cutoff_reminder:{userId}:{firstMatchId}`

---

### `prode.bet_reminder`
**Trigger:** Recordatorio opt-in pre-kickoff (del usuario, elige minutos antes)  
**Archivo:** `services/betReminders.js:58`  
**Canal sugerido:** SMS, WhatsApp

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.match.local` | string | `"Brasil"` |
| `business_context.match.away` | string | `"Serbia"` |
| `business_context.remind_minutes` | number | `30` |
| `business_context.bet.goles_local` | number\|null | `2` |
| `business_context.bet.goles_visitante` | number\|null | `1` |

**Idempotency:** `bet_reminder:{userId}:{matchId}`

---

### `prode.tournament_tomorrow`
**Trigger:** Torneo arranca mañana (23–25h antes)  
**Archivo:** `services/reminderTournament.js:75`  
**Canal sugerido:** Email, SMS

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.tournament_name` | string | `"Fase de Grupos - Jornada 2"` |
| `business_context.pending_bets` | number | `4` |

**Idempotency:** `tournament_tomorrow:{userId}:{firstMatchId}`

---

### `prode.payment_pending`
**Trigger:** Planilla no pagada, torneo arranca en menos de 7 días  
**Archivo:** `services/reminderPayment.js:65`  
**Canal sugerido:** Email, SMS, WhatsApp

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.planilla_nombre` | string | `"Mi Planilla"` |
| `business_context.torneo_name` | string | `"Mundial 2026"` |
| `business_context.days_left` | number | `3` |

**Idempotency:** `payment_pending:{userId}:{firstMatchId}`

---

## 3. Partidos en vivo

### `prode.kickoff`
**Trigger:** Arranca el partido  
**Archivo:** `workers/schedulerService.js:249`  
**Canal sugerido:** SMS

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.match.local` | string | `"Argentina"` |
| `business_context.match.away` | string | `"México"` |
| `business_context.bet.goles_local` | number\|null | `2` |
| `business_context.bet.goles_visitante` | number\|null | `0` |

**Idempotency:** `kickoff:{userId}:{matchId}`

---

### `prode.second_half`
**Trigger:** Arranca el segundo tiempo  
**Archivo:** `workers/schedulerService.js:249`  
**Canal sugerido:** SMS

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.match.local` | string | `"Argentina"` |
| `business_context.match.away` | string | `"México"` |
| `business_context.bet.goles_local` | number\|null | `2` |
| `business_context.bet.goles_visitante` | number\|null | `0` |

**Idempotency:** `second_half:{userId}:{matchId}`

---

### `prode.match_rescheduled`
**Trigger:** Se reprograma un partido  
**Archivo:** `routes/matches.js:308`  
**Canal sugerido:** Email, SMS, WhatsApp

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.match.local` | string | `"Brasil"` |
| `business_context.match.away` | string | `"Alemania"` |
| `business_context.match.new_datetime` | string | `"viernes 20 de junio, 16:00"` |

**Idempotency:** `match_rescheduled:{userId}:{matchId}`

---

## 4. Resultados y puntos

### `prode.result_published.individual`
**Trigger:** Admin publica resultado de un partido (uno por usuario)  
**Archivo:** `services/resultNotifications.js:209`  
**Canal sugerido:** Email, WhatsApp

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.match.local` | string | `"Argentina"` |
| `business_context.match.away` | string | `"Arabia Saudita"` |
| `business_context.match.goles_local` | number | `3` |
| `business_context.match.goles_visitante` | number | `0` |
| `business_context.bet.goles_local` | number | `2` |
| `business_context.bet.goles_visitante` | number | `0` |
| `business_context.bet.puntos_obtenidos` | number | `3` |
| `business_context.ranking_after.position` | number | `5` |
| `business_context.outcome` | string\|null | `"exacto"`, `"resultado"`, `null` |

**Idempotency:** `result_published:{userId}:{matchId}`

---

### `prode.result_published.broadcast`
**Trigger:** Resultado publicado — aviso general a todos  
**Archivo:** `services/resultNotifications.js:301`  
**Canal sugerido:** Email

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.match.local` | string | `"Argentina"` |
| `business_context.match.away` | string | `"Arabia Saudita"` |
| `business_context.match.goles_local` | number | `3` |
| `business_context.match.goles_visitante` | number | `0` |
| `business_context.exactos_count` | number | `4` |

**userId:** `"broadcast"` (especial)  
**Idempotency:** `result_broadcast:{matchId}`

---

## 5. Ranking y posiciones

### `prode.new_leader`
**Trigger:** Cambio de líder del ranking  
**Archivo:** `services/resultNotifications.js:63`  
**Canal sugerido:** WhatsApp

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.puntos` | number | `42` |
| `business_context.prev_leader_nombre` | string\|null | `"Martín"` |
| `business_context.match.local` | string | `"Brasil"` |
| `business_context.match.away` | string | `"Serbia"` |
| `business_context.match.goles_local` | number | `1` |
| `business_context.match.goles_visitante` | number | `0` |

**Idempotency:** `new_leader:{userId}:{matchId}`

---

### `prode.ranking_change.entered` / `.up` / `.down`
**Trigger:** Posición del usuario cambia después de resultado  
**Archivo:** `routes/matches.js:434`  
**Canal sugerido:** SMS (up/entered), suprimido (down)

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.old_rank` | number\|null | `8` |
| `business_context.new_rank` | number | `5` |
| `business_context.delta` | number\|null | `3` |
| `business_context.puntos_totales` | number | `42` |
| `business_context.planilla_nombre` | string | `"La cábala"` |

**Idempotency:** `ranking_change:{userId}:{matchId}`

---

### `prode.near_podio`
**Trigger:** Usuario queda a ≤5 puntos del 3er puesto  
**Archivo:** `routes/matches.js:532`  
**Canal sugerido:** SMS, WhatsApp

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.gap` | number | `3` |
| `business_context.podio3_nombre` | string | `"Carlos"` |
| `business_context.planilla_nombre` | string | `"La cábala"` |
| `business_context.position` | number | `6` |

**Idempotency:** `near_podio:{userId}:{matchId}`

---

## 6. Jornadas (matchdays)

### `prode.matchday_summary`
**Trigger:** Terminan todos los partidos de una fecha  
**Archivo:** `routes/matchdays.js:485`  
**Canal sugerido:** Email

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.matchday_name` | string | `"Fecha 3"` |
| `business_context.points` | number | `9` |
| `business_context.rank_in_matchday` | number | `2` |
| `business_context.global_position` | number\|null | `5` |
| `business_context.total_planillas` | number | `45` |
| `business_context.top_name` | string | `"Juan"` |
| `business_context.top_points` | number | `12` |
| `business_context.is_winner` | boolean | `false` |

**Idempotency:** `matchday_summary:{userId}:{matchdayId}`

---

### `prode.personal_record`
**Trigger:** Usuario bate su récord personal en una fecha  
**Archivo:** `routes/matchdays.js:535`  
**Canal sugerido:** SMS

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.points` | number | `14` |
| `business_context.prev_max` | number\|null | `11` |
| `business_context.matchday_name` | string | `"Fecha 5"` |

**Idempotency:** `personal_record:{userId}:{matchdayId}`

---

### `prode.streak_exactos`
**Trigger:** Usuario tiene racha de exactos consecutivos  
**Archivo:** `routes/matchdays.js:586`  
**Canal sugerido:** SMS

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.streak` | number | `3` |
| `business_context.matchday_name` | string | `"Fecha 4"` |

**Idempotency:** `streak_exactos:{userId}:{matchdayId}`

---

## 7. Ganadores

### `prode.winner.personal`
**Trigger:** Usuario ganó la jornada  
**Archivo:** `routes/matchdays.js:232`  
**Canal sugerido:** Email, WhatsApp

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.winner_name` | string | `"Pedro"` |
| `business_context.matchday_name` | string | `"Fecha 3"` |
| `business_context.points` | number | `14` |
| `business_context.scorer_line` | string | `"Goleadores: Messi (2), Lautaro"` |
| `business_context.image_url` | string (opt) | `"https://..."` |

**Idempotency:** `winner_personal:{userId}:{matchdayId}`

---

### `prode.winner.broadcast`
**Trigger:** Aviso a todos los usuarios de quién ganó  
**Archivo:** `routes/matchdays.js:282`  
**Canal sugerido:** Email

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.winner_name` | string | `"Pedro"` |
| `business_context.matchday_name` | string | `"Fecha 3"` |
| `business_context.points` | number | `14` |
| `business_context.scorer_line` | string | `"Goleadores: Messi (2), Lautaro"` |
| `business_context.image_url` | string (opt) | `"https://..."` |

**Idempotency:** `winner_broadcast:{userId}:{matchdayId}`

---

## 8. Voice (Engage → llamada/voz)

### `prode.voice_match_reminder`
**Trigger:** Cron cada 5 min, partidos en 25–35 min  
**Archivo:** `services/voiceMatchReminder.js:135`

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.template` | string | `"Match Reminder Prode"` |
| `business_context.home_team` | string | `"Argentina"` |
| `business_context.away_team` | string | `"México"` |
| `business_context.minutes_to_kickoff` | number | `25` |
| `business_context.bet_local` | number\|null | `2` |
| `business_context.bet_visitante` | number\|null | `1` |

**Idempotency:** `voice_match_reminder:{userId}:{matchId}`

---

### `prode.voice_nuevo_lider`
**Trigger:** Nuevo líder del ranking (voz)  
**Archivo:** `services/resultNotifications.js:84`

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.template` | string | `"Nuevo Lider Prode"` |
| `business_context.nuevo_lider` | string | `"Carlos"` |
| `business_context.puntos` | number | `42` |
| `business_context.prev_leader` | string\|null | `"Martín"` |
| `business_context.match_name` | string | `"Argentina vs México"` |

**Idempotency:** `voice_nuevo_lider:{userId}:{matchId}`

---

### `prode.voice_perfect_score`
**Trigger:** Usuario acertó marcador exacto  
**Archivo:** `services/resultNotifications.js:225`

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.template` | string | `"Exacto Prode"` |
| `business_context.home_team` | string | `"Brasil"` |
| `business_context.away_team` | string | `"Serbia"` |
| `business_context.goles_local` | number | `2` |
| `business_context.goles_visitante` | number | `0` |
| `business_context.puntos` | number | `4` |
| `business_context.ranking_pos` | number | `3` |

**Idempotency:** `voice_exacto:{userId}:{matchId}`

---

### `prode.voice_trash_talk`
**Trigger:** Un rival te pasa en el ranking  
**Archivo:** `routes/matches.js:501`

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.template` | string | `"Trash Talk Prode"` |
| `business_context.rival_nombre` | string | `"Martín"` |
| `business_context.rival_pos` | number | `4` |
| `business_context.mi_pos` | number | `5` |
| `business_context.rival_puntos` | number | `38` |
| `business_context.mis_puntos` | number | `36` |

**Idempotency:** `voice_trash_talk:{userId}:{matchId}:{overtakerId}`

---

### `prode.voice_survey`
**Trigger:** 5 días antes del torneo  
**Archivo:** `services/voice5dayReminder.js:132`

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.template` | string | `"Onboarding Workcup 2026"` |
| `business_context.tournament_name` | string | `"Mundial 2026"` |
| `business_context.pending_bets` | number | `48` |
| `business_context.days_left` | number | `5` |

**Idempotency:** `voice_5days:{userId}:{firstMatchId}`

---

### `prode.voice_survey_campeon`
**Trigger:** Admin dispara encuesta manual  
**Archivo:** `routes/admin.js:587`

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.template` | string | `"Survey Campeon Mundial"` |
| `business_context.options` | array | `[{digit: 1, label: "Argentina"}, ...]` |

**Idempotency:** `voice_campeon:{userId}:mundial2026`

---

### `prode.voice_weekly_summary`
**Trigger:** Resumen semanal por voz  
**Archivo:** `routes/admin.js:227`

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.template` | string | `"Weekly Summary Prode"` |
| `business_context.week_date` | string | `"Lunes 23 de junio"` |
| `business_context.leader_nombre` | string\|null | `"Carlos"` |
| `business_context.leader_puntos` | number\|null | `52` |
| `business_context.ranking_position` | number | `7` |
| `business_context.total_players` | number | `45` |
| `business_context.pending_bets` | number | `3` |

**Idempotency:** `voice_weekly:{userId}:{weekDate}`

---

## 9. Broadcasts y admin

### `prode.weekly_digest`
**Trigger:** Resumen semanal por email (admin dispara)  
**Archivo:** `routes/admin.js:196`  
**Canal sugerido:** Email

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.week_date` | string | `"Lunes 23 de junio"` |
| `business_context.ranking_position` | number | `7` |
| `business_context.total_players` | number | `45` |
| `business_context.points` | number | `38` |
| `business_context.best_round` | string\|null | `"Fecha 3"` |
| `business_context.best_round_points` | number | `12` |
| `business_context.diferencia_puntos` | number | `5` |
| `business_context.pending_bets` | number | `3` |
| `business_context.tight_match` | object\|null | `{home_team, away_team, ...}` |
| `business_context.upcoming_matches` | array | `[{home_team, away_team, start_time}]` |

**Idempotency:** `weekly_digest:{userId}:{weekDate}`

---

### `prode.broadcast_manual`
**Trigger:** Admin dispara broadcast WhatsApp manual  
**Archivo:** `lambda.js:72`  
**Canal sugerido:** Email, SMS, WhatsApp

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.message` | string | `"Atención: se agregaron 4 partidos nuevos"` |

**Idempotency:** *(no definido — posible duplicado)*

---

### `prode.planilla_cierre`
**Trigger:** Primer kickoff del torneo (las apuestas se bloquean)  
**Archivo:** `workers/schedulerService.js:123`  
**Canal sugerido:** Email

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `business_context.planilla_nombre` | string | `"Mi Planilla"` |
| `business_context.torneo_name` | string | `"Mundial 2026"` |
| `business_context.matches` | array | `[{home_team, away_team, goles_local, goles_visitante}]` |

**Idempotency:** `planilla_cierre:{userId}:{firstMatchId}`

---

## Resumen

| # | Evento | Canal principal | Trigger |
|---|--------|-----------------|---------|
| 1 | `prode.verification_code` | Email, SMS | Registro |
| 2 | `prode.welcome` | Email, WhatsApp | Registro completo |
| 3 | `prode.cutoff_reminder` | Email, WhatsApp, SMS | 20-40 min antes del cierre |
| 4 | `prode.bet_reminder` | SMS, WhatsApp | Opt-in pre-kickoff |
| 5 | `prode.tournament_tomorrow` | Email, SMS | 24h antes del torneo |
| 6 | `prode.payment_pending` | Email, SMS, WhatsApp | Planilla impaga, <7 días |
| 7 | `prode.kickoff` | SMS | Arranca partido |
| 8 | `prode.second_half` | SMS | Segundo tiempo |
| 9 | `prode.match_rescheduled` | Email, SMS, WhatsApp | Reprogramación |
| 10 | `prode.result_published.individual` | Email, WhatsApp | Resultado publicado |
| 11 | `prode.result_published.broadcast` | Email | Resultado (todos) |
| 12 | `prode.new_leader` | WhatsApp | Cambio de líder |
| 13 | `prode.ranking_change.*` | SMS | Cambio de posición |
| 14 | `prode.near_podio` | SMS, WhatsApp | Cerca del podio |
| 15 | `prode.matchday_summary` | Email | Resumen de fecha |
| 16 | `prode.personal_record` | SMS | Récord personal |
| 17 | `prode.streak_exactos` | SMS | Racha de exactos |
| 18 | `prode.winner.personal` | Email, WhatsApp | Ganaste la fecha |
| 19 | `prode.winner.broadcast` | Email | Quién ganó (todos) |
| 20 | `prode.voice_match_reminder` | Voice | 30 min antes kickoff |
| 21 | `prode.voice_nuevo_lider` | Voice | Nuevo líder |
| 22 | `prode.voice_perfect_score` | Voice | Exacto |
| 23 | `prode.voice_trash_talk` | Voice | Te pasaron en ranking |
| 24 | `prode.voice_survey` | Voice | 5 días antes |
| 25 | `prode.voice_survey_campeon` | Voice | Encuesta manual |
| 26 | `prode.voice_weekly_summary` | Voice | Resumen semanal |
| 27 | `prode.weekly_digest` | Email | Digest semanal |
| 28 | `prode.broadcast_manual` | Email, SMS, WhatsApp | Broadcast admin |
| 29 | `prode.planilla_cierre` | Email | Primer kickoff |

**Total: 29 eventos**
