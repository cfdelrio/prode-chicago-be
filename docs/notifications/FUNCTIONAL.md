# Notificaciones — Especificación funcional

Documento orientado a producto y operación. Describe **qué** comunica el sistema, **a quién**, **cuándo** y **por qué canal**, sin entrar en detalles de implementación.

---

## 1. Canales disponibles

| Canal | Provider | Cuándo se usa |
|-------|----------|---------------|
| **Push (PWA)** | Web Push API | El usuario instaló la app y aceptó notificaciones del navegador. |
| **SMS** | Infobip | El usuario cargó su número y prendió el check de WhatsApp. Llega como SMS regular (no requiere que abra WhatsApp). |
| **WhatsApp** | Twilio + templates aprobados por Meta | Solo para mensajes operativos (nuevo líder, resultado de partido, ganador de fecha) y broadcasts manuales del admin. |
| **Email** | SES | Resúmenes semanales, ranking change, nuevo líder, resultado publicado. |
| **In-app** | Tabla `notifications` en DB | Historial visible en `/notificaciones` de la app — el usuario ve todo lo que se le envió. |

> Cada notificación puede salir por **uno o más canales** simultáneamente.

---

## 2. Tipos de notificación

### 2.1 Recordatorio de cierre del torneo (`cutoff_reminder`)

- **Quién la recibe:** Usuarios con al menos una planilla que tiene pronósticos pendientes en un torneo activo.
- **Cuándo se dispara:** Entre 20 y 40 minutos antes de que cierre el torneo (el cierre = `start_time del primer partido − cutoff_minutes` configurable por torneo, default 5 min).
- **Periodicidad:** El cron corre cada 5 min. Cada combinación (usuario, torneo) recibe el aviso **una sola vez** por cutoff.
- **Canales:** Push + SMS (si tiene número + consent) + historial in-app.
- **Mensaje:**
  - Push: `⏰ Cierra en N min` / cuerpo personalizado según cantidad de pronósticos faltantes.
  - SMS: `⏰ Mundial 2026: te faltan 3 pronósticos — tenés 22 min para cargarlos 👉 prodecaballito.com/apuestas`

### 2.2 Recordatorio antes del partido (`bet_reminder`)

- **Quién la recibe:** Usuarios que activaron el opt-in al cargar la apuesta. El usuario elige los minutos de anticipación (default 30, opciones: 5/10/15/30/60).
- **Cuándo se dispara:** `start_time del partido − minutos elegidos`. Se procesa en cada corrida del cron (5 min) y solo dispara cuando el momento programado ya pasó.
- **Periodicidad:** Una sola vez por reminder.
- **Canales:** Push + SMS (si corresponde) + historial in-app.
- **Mensaje:**
  - Push: `⚽ Empieza en 30 min` — `Argentina vs Brasil — tu pronóstico: 2-1`
  - SMS: `⚽ Argentina vs Brasil empieza en 30 min — tu pronóstico: 2-1 🤞 prodecaballito.com`
  - Si el usuario no cargó pronóstico, se omite la parte de "tu pronóstico".

### 2.3 Arranque y segundo tiempo del partido (`kickoff` / `second_half`)

- **Quién la recibe:** Todos los usuarios que apostaron a ese partido.
- **Cuándo se dispara:** Al `start_time` (kickoff) y al `start_time + 45 min + halftime_minutes` (segundo tiempo).
- **Periodicidad:** Una vez por partido por tipo de evento.
- **Canales:** Push + SMS (si corresponde) + historial in-app.
- **Mensaje:**
  - Kickoff: `⚽ ¡Empieza! Argentina vs Brasil — tu pronóstico: 2-1 👉 prodecaballito.com`
  - Segundo tiempo: `⚽ ¡Segundo tiempo! Argentina vs Brasil — tu pronóstico: 2-1 👉 prodecaballito.com`

### 2.4 Resultado publicado (`result_published`)

- **Quién la recibe:** Cada usuario con apuesta en ese partido. Adicionalmente, todos los suscriptores reciben un broadcast push.
- **Cuándo se dispara:** Inmediatamente después de que un admin publique el resultado.
- **Canales:**
  - Email personalizado con tu pronóstico, los puntos y tu posición actual.
  - SMS personalizado con el resultado, tu pronóstico, los puntos y tu posición.
  - Push broadcast general: `⚽ ARG 2–1 BRA — Resultado publicado, mirá cuántos puntos sumaste`.
  - Historial in-app con el detalle de tus puntos.
- **Mensaje individual ejemplo (SMS):**
  ```
  ⚽ Argentina 2-1 Brasil
  🎯 Tu pronóstico: 2-1 → +4pts
  🏆 Estás #3 en el ranking
  👉 prodecaballito.com/ranking
  ```

### 2.5 Cambio de posición en el ranking (`ranking_change`)

- **Quién la recibe:** Cada usuario cuya planilla cambió de posición tras una publicación de resultado.
- **Cuándo se dispara:** En cada recálculo de ranking (al publicar un resultado).
- **Canales:** Email + historial in-app. (No genera push ni SMS para no spamear.)
- **Mensaje:**
  - Subiste: `🚀 ¡Subiste en el ranking! — Avanzaste 3 posiciones. Ahora estás #2 en "Mi Planilla"`
  - Bajaste: `📉 Bajaste en el ranking — Bajaste 1 posición. Ahora estás #5 en "Mi Planilla"`
  - Primera vez: `⭐ ¡Entraste al ranking! — Arrancás en el puesto #7 en "Mi Planilla"`

### 2.6 Nuevo líder del ranking (`ranking` / nuevo líder)

- **Quién la recibe:** El usuario que pasó a estar en el puesto #1.
- **Cuándo se dispara:** Al publicar un resultado, si el líder cambia respecto del anterior.
- **Canales:** Email + push + SMS + historial in-app.
- **Mensaje SMS:**
  ```
  🔥 ¡Sos el nuevo líder del PRODE Caballito! Con 42 pts estás en el puesto #1.
  ¡No lo sueltes! 👉 prodecaballito.com/ranking
  ```

### 2.7 Ganador de la fecha

- **Quién la recibe:** Todos los jugadores. El ganador recibe el destacado.
- **Cuándo se dispara:** Cuando se cierra una fecha (todos sus partidos están finalizados).
- **Canales:** Email + WhatsApp template aprobado (`prode_ganador_fecha`).
- **Mensaje WhatsApp:**
  ```
  🏆 ¡Juan Pérez ganó Fecha 1!
  Con 18 puntos exactos.
  👉 prodecaballito.com/ranking
  ```

### 2.8 Resumen semanal (`weekly-digest`)

- **Quién la recibe:** Todos los usuarios.
- **Cuándo se dispara:** Una vez por semana (cron EventBridge `prode.weekly`).
- **Canales:** Email.
- **Contenido:** Resumen de la semana — partidos jugados, tu performance, próximos cierres.

### 2.9 Broadcast manual del admin

- **Quién la recibe:** Todos los usuarios con `whatsapp_consent = true`.
- **Cuándo se dispara:** Manual desde el panel admin.
- **Canales:** WhatsApp libre (Twilio).
- **Uso típico:** Comunicación de novedades, promos, problemas operativos.

---

## 3. Consentimiento del usuario

| Permiso | Cómo se obtiene | Default |
|---------|-----------------|---------|
| **Push (PWA)** | Botón explícito en `/notificaciones` + permiso del browser | Off |
| **SMS** | Check "Quiero recibir avisos por SMS" + cargar número en `/profile` | Off |
| **WhatsApp template** | Mismo `whatsapp_consent` que SMS | Off |
| **Email** | Implícito al registrarse (es el canal de cuenta) | On |
| **In-app** | No requiere — siempre se registra | — |

**Revocación:** El usuario puede apagar SMS/push desde `/profile`. El email se revoca por unsubscribe individual.

---

## 4. Historial in-app

Toda notificación generada por el sistema queda registrada en `notifications` (con título, cuerpo, ícono y tipo). El usuario las consulta en `/notificaciones`. Al abrir la página, las notificaciones con estado `sent` pasan automáticamente a `read`.

**Estados:**
- `pending` — generada, todavía no enviada por ningún canal externo (caso raro).
- `sent` — enviada / vista en la lista pero el usuario no la abrió.
- `read` — el usuario consultó su listado.
- `failed` — error al persistir (no debería verse en la lista).

---

## 5. Whitelists y modos sandbox

Para evitar costos / ruido en pruebas:

- `WHATSAPP_WHITELIST` y `SMS_WHITELIST` (env vars del backend) limitan el envío a los números explícitos. En producción se dejan vacías para enviar a todos.
- `WHATSAPP_ENABLED=false` apaga **todo** envío por WhatsApp (útil cuando la cuenta Twilio/Meta está restringida).

---

## 6. Reglas operativas

1. **Idempotencia:** ningún recordatorio se manda dos veces al mismo usuario para el mismo evento, incluso si el cron corre varias veces dentro de la ventana.
2. **Retries silenciosos:** si Infobip falla por error transitorio (5xx), el sistema reintenta 3 veces con backoff. El usuario nunca ve eso.
3. **No spam:** un único cambio de ranking → una notificación in-app por planilla. No se duplica push por publicar varios resultados seguidos.
4. **Privacidad:** el número de WhatsApp solo se muestra en la app a otros usuarios si el dueño lo consintió (`whatsapp_consent = true`).

---

## 7. Roadmap / decisiones pendientes

- Definir qué hacer si un usuario revoca consent después de tener reminders programados (hoy: los reminders saltan SMS pero igual envían push).
- Posible separación de `ranking_change` en "subida grande" vs "movimiento marginal" para evitar mensajes triviales.
- Considerar throttling de notificaciones in-app si un usuario tiene >10 planillas (caso edge).
