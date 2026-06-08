# ProdeCaballito - Instrucciones para Claude Code

## Objetivo
Mejorar la app ProdeCaballito sin romper lo existente.

## Estilo
- Deportivo, argentino, competitivo.
- Inspiración ESPN / TyC / Mundial.
- No usar tono casino ni apuestas ilegales.

## 🧭 Boy Scout Rule — OBLIGATORIO

**"Always leave the code cleaner than you found it."**

Cada vez que modifiques código:
1. Resuelve el problema principal ✅
2. Mejora **algo** del área tocada (sin refactor gigante)
3. Deja el código un poco más limpio que lo que encontraste

### Checklist antes de terminar (SIEMPRE)
- [ ] Nombres claros y consistentes
- [ ] Código muerto eliminado
- [ ] Lógica simplificada
- [ ] Tipos explícitos (TypeScript strict)
- [ ] Imports organizados
- [ ] Error handling robusto
- [ ] Validaciones Zod (inputs críticos)
- [ ] Lint + typecheck + build sin warnings
- [ ] Tests existentes siguen pasando
- [ ] Consistencia con patterns existentes
- [ ] No hay `any`, `@ts-ignore`, hacks temporales, TODOs vacíos

### Prohibido
- Copy/paste de lógica
- Rewrites masivos
- Cambios cosméticos sin valor
- Romper arquitectura actual
- Duplicar código/componentes

### Mentalidad
Cada commit debe dejar el sistema: más limpio, más claro, más consistente, más mantenible.

---

## Reglas técnicas
- Antes de modificar, revisar estructura actual.
- No inventar endpoints.
- No borrar archivos sin pedir confirmación.
- Mantener responsive desktop/mobile.
- Si falta información, crear TODO o backlog.

## Flujo de trabajo (Gitflow)

Seguimos **Gitflow Workflow** ([Atlassian Gitflow Guide](https://www.atlassian.com/es/git/tutorials/comparing-workflows/gitflow-workflow)):

### Ramas principales
- **`main`** - Código en producción. Protegida (solo PRs). Cada commit es release.
- **`develop`** - Rama de integración. Base para feature branches.

### Ramas de feature
- **`claude/feature-name-XXXXX`** - Crear desde `develop`, no `main`.
- Nombrar con prefijo `claude/` + descripción breve + ID único.
- Abrir PR hacia `develop` (no hacia `main`).
- Deletear después de mergear.

### Ramas de release & hotfix
- **`release/v*`** - Preparar release (ajustes menores).
- **`hotfix/v*`** - Bugfix urgente en producción.

### Paso a paso
1. **Crear feature branch:**
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b claude/tu-feature-Y7rEo
   ```

2. **Hacer cambios:**
   - Commits claros y atómicos.
   - Tests + build check antes de push.

3. **Abrir PR:**
   - Base: `develop` (no `main`).
   - Descripción: qué, por qué, test plan.
   - Esperar review + merge.

4. **Después del merge:**
   - `develop` → `main` es responsabilidad de release manager.
   - Solo release/hotfix branches mergean a `main`.

### Por qué Gitflow
- ✅ Separación clara: features vs producción.
- ✅ Protege `main` de cambios rotos.
- ✅ Permite múltiples features en paralelo.
- ✅ Release ordenado (staging → prod).

## Flujo de implementación (paso a paso)
1. **`git pull origin <rama-actual>`** antes de escribir cualquier línea de código.
2. Analizar archivos.
3. Proponer plan.
4. Implementar cambios mínimos y seguros.
5. Probar build.
6. Resumir cambios y crear PR.
