'use strict';

const { buildUserContact, buildUserProfile, buildEngageMetadata } = require('../utils/engageHelpers');

describe('engageHelpers', () => {
  describe('buildUserContact', () => {
    test('returns empty object on null/undefined user', () => {
      expect(buildUserContact(null)).toEqual({});
      expect(buildUserContact(undefined)).toEqual({});
    });

    test('maps all standard fields', () => {
      const user = {
        nombre: 'Carlos',
        email: 'carlos@example.com',
        whatsapp_number: '+5491155555555',
        whatsapp_consent: true,
        idioma_pref: 'pt-BR',
      };
      expect(buildUserContact(user)).toEqual({
        nombre: 'Carlos',
        email: 'carlos@example.com',
        phone: '+5491155555555',
        whatsapp_consent: true,
        idioma_pref: 'pt-BR',
      });
    });

    test('coerces whatsapp_consent to boolean', () => {
      expect(buildUserContact({ whatsapp_consent: null }).whatsapp_consent).toBe(false);
      expect(buildUserContact({ whatsapp_consent: 'true' }).whatsapp_consent).toBe(true);
      expect(buildUserContact({ whatsapp_consent: 0 }).whatsapp_consent).toBe(false);
    });

    test('falls back to es-AR if idioma_pref missing', () => {
      expect(buildUserContact({}).idioma_pref).toBe('es-AR');
      expect(buildUserContact({ idioma_pref: null }).idioma_pref).toBe('es-AR');
    });

    test('null for missing canal fields (no undefined)', () => {
      const result = buildUserContact({ nombre: 'Carlos' });
      expect(result.email).toBeNull();
      expect(result.phone).toBeNull();
      expect(result.nombre).toBe('Carlos');
    });
  });

  describe('buildUserProfile', () => {
    test('returns sensible defaults on empty user', () => {
      const p = buildUserProfile(null);
      expect(p.tema_equipo).toBeNull();
      expect(p.foto_url).toBeNull();
      expect(p.rol).toBe('usuario');
      expect(p.current_streak).toBe(0);
      expect(p.best_streak).toBe(0);
      expect(p.badges_count).toBe(0);
    });

    test('maps user attributes', () => {
      const user = {
        tema_equipo: 'river',
        foto_url: 'https://cdn.example.com/a.jpg',
        created_at: '2025-01-15T00:00:00Z',
        rol: 'admin',
      };
      const p = buildUserProfile(user);
      expect(p.tema_equipo).toBe('river');
      expect(p.foto_url).toBe('https://cdn.example.com/a.jpg');
      expect(p.fecha_registro).toBe('2025-01-15T00:00:00Z');
      expect(p.rol).toBe('admin');
    });

    test('merges extras (planilla + gamification + ranking)', () => {
      const p = buildUserProfile({ tema_equipo: 'boca' }, {
        planilla_nombre: 'Mi Planilla',
        planilla_id: 'uuid-1',
        tournament_name: 'Mundial 2026',
        estado_pago: true,
        current_streak: 5,
        best_streak: 7,
        badges_count: 3,
        ranking_position: 4,
        puntos_totales: 42,
      });
      expect(p.tema_equipo).toBe('boca');
      expect(p.planilla_nombre).toBe('Mi Planilla');
      expect(p.tournament_name).toBe('Mundial 2026');
      expect(p.estado_pago).toBe(true);
      expect(p.current_streak).toBe(5);
      expect(p.best_streak).toBe(7);
      expect(p.badges_count).toBe(3);
      expect(p.ranking_position).toBe(4);
      expect(p.puntos_totales).toBe(42);
    });

    test('estado_pago: null when undefined, boolean when given', () => {
      expect(buildUserProfile({}).estado_pago).toBeNull();
      expect(buildUserProfile({}, { estado_pago: false }).estado_pago).toBe(false);
      expect(buildUserProfile({}, { estado_pago: 1 }).estado_pago).toBe(true);
    });
  });

  describe('buildEngageMetadata', () => {
    test('combines contact + profile into the metadata shape', () => {
      const user = {
        nombre: 'Carlos', email: 'c@x.com', whatsapp_number: '+5491100000000',
        whatsapp_consent: true, idioma_pref: 'es-AR',
        tema_equipo: 'river', foto_url: 'http://x/a.jpg', rol: 'usuario',
      };
      const meta = buildEngageMetadata(user, {
        planilla_nombre: 'P1', current_streak: 3, ranking_position: 1, puntos_totales: 50,
      });
      expect(meta).toHaveProperty('user_contact');
      expect(meta).toHaveProperty('user_profile');
      expect(meta.user_contact.nombre).toBe('Carlos');
      expect(meta.user_contact.phone).toBe('+5491100000000');
      expect(meta.user_profile.tema_equipo).toBe('river');
      expect(meta.user_profile.planilla_nombre).toBe('P1');
      expect(meta.user_profile.current_streak).toBe(3);
      expect(meta.user_profile.ranking_position).toBe(1);
    });
  });
});
