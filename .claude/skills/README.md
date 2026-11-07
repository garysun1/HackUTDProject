# Vendored design skills

- `impeccable/` — pbakaus/impeccable 4.8.0 (Apache 2.0). Markdown only: the binary launcher and
  the Claude settings hooks are not vendored. Agents follow SKILL.md's "Launcher unavailable"
  path: read `web/PRODUCT.md` and `web/DESIGN.md`, then the relevant reference file, then
  `reference/craft-floor.md` before any UI edit. Modes: the dashboard is **Operate**, the
  landing page is **Persuade**.
- `design-taste-frontend/` — Leonxlnx/taste-skill 2.5.1 (MIT). For the landing page only.
  Its Stop hook and Node scripts are not vendored; the component and background assets are.
- `dataviz` is provided by the Claude session itself and governs the graph, timeline, and
  alert tiles.

Assets (components, backgrounds, effects kit, 38 MB) are not vendored; fetch from https://github.com/Leonxlnx/taste-skill when the landing page needs them.
