'use strict';

/**
 * Helpers para construir el payload `metadata` enviado a Engage.
 *
 * Engage usa estos datos para:
 *  - `user_contact`: routing por canal + consent + idioma (críticos para entrega)
 *  - `user_profile`: atributos disponibles en templates para personalización
 *
 * Patrón: cada sendEvent debería usar estos builders en vez de armar
 * el objeto a mano. Esto evita duplicación y permite enriquecer todos
 * los eventos editando un solo lugar.
 */

/**
 * Datos mínimos para que Engage pueda contactar al user en algún canal.
 * Lo que pongamos acá determina por dónde puede salir el mensaje.
 *
 * @param {object} user - Row de la tabla users (o subset con esos campos)
 * @returns {object}
 */
function buildUserContact(user) {
    if (!user || typeof user !== 'object') return {};
    return {
        nombre: user.nombre || null,
        email: user.email || null,
        phone: user.whatsapp_number || null,
        whatsapp_consent: !!user.whatsapp_consent,
        idioma_pref: user.idioma_pref || 'es-AR',
    };
}

/**
 * Atributos de perfil disponibles para usar en templates de Engage.
 * Engage hace upsert implícito sobre el contact con `userId` + estos campos.
 *
 * Los `extras` permiten pasar datos derivados (planilla activa, streak,
 * ranking position) que no están en la tabla users.
 *
 * @param {object} user - Row de la tabla users
 * @param {object} [extras] - Datos enriquecidos del contexto (gamification, ranking, planilla)
 * @returns {object}
 */
function buildUserProfile(user, extras = {}) {
    if (!user || typeof user !== 'object') user = {};
    return {
        // Atributos del user
        tema_equipo: user.tema_equipo || null,
        foto_url: user.foto_url || null,
        fecha_registro: user.created_at || null,
        rol: user.rol || 'usuario',

        // Atributos de planilla/torneo (vienen via extras)
        planilla_nombre: extras.planilla_nombre || null,
        planilla_id: extras.planilla_id || null,
        tournament_name: extras.tournament_name || null,
        estado_pago: extras.estado_pago === undefined ? null : !!extras.estado_pago,

        // Atributos de gamification (vienen via extras)
        current_streak: extras.current_streak || 0,
        best_streak: extras.best_streak || 0,
        badges_count: extras.badges_count || 0,

        // Atributos de ranking (vienen via extras)
        ranking_position: extras.ranking_position || null,
        puntos_totales: extras.puntos_totales || null,
    };
}

/**
 * Combina contact + profile en el shape exacto que Engage espera
 * en `metadata`. Atajo para no escribir las dos llamadas en cada call site.
 *
 * @param {object} user
 * @param {object} [extras]
 * @returns {{ user_contact: object, user_profile: object }}
 */
function buildEngageMetadata(user, extras = {}) {
    return {
        user_contact: buildUserContact(user),
        user_profile: buildUserProfile(user, extras),
    };
}

module.exports = {
    buildUserContact,
    buildUserProfile,
    buildEngageMetadata,
};
