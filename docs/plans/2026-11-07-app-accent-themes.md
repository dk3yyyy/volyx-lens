# App Accent Themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three curated accent themes to Volyx Lens — Indigo (default), Sage, and Ember — selectable in Settings, persisted through the existing store, applied before first paint, and accessible in every focused and inactive state.

**Architecture:** Keep the dark graphite glass surfaces, text ramp, and status colours shared. Split the accent family into foreground (`--accent`), solid fill (`--accent-fill` with `--accent-ink`), hover/gradient (`--accent-fill-hi`), focus (`--accent-soft`), decorative tint, and inactive variants. Theme selection lives in `appearance.theme`, applies through `data-accent-theme` on `<html>`, and is bootstrapped before the stylesheet by a self-hosted head script reading one validated preload value.

**Tech Stack:** Electron 32, CommonJS main/preload, vanilla renderer JavaScript, plain CSS custom properties, `node:test`, Electron settings harness.

**Spec:** This document, “Design Contract (v1)”. The audits behind it are in `/tmp/vl-theme-css/`, `/tmp/vl-theme-palette/`, and `/tmp/vl-theme-tests/theme-verification-plan.md`.

## Global Constraints

- Exactly three ids: `indigo`, `sage`, `ember`. Default `indigo`; no custom or free-form themes.
- v1 changes accent only. Surfaces, text ramp, status colours (`--cyan`, `--live`, `--warning`, `--danger`), glass, radius, density and layout stay shared.
- Renderer attribute is `data-accent-theme` on `<html>`, never `data-theme` (reserved by existing `html[data-theme='light']` badge rules).
- Setting shape is `appearance: { theme: '<id>' }`. Unknown values and unknown subkeys are dropped.
- No new runtime dependencies. No inline script: `renderer/index.html` CSP is `script-src 'self'`.
- Every accent/fill pair must meet 4.5:1 for text at 10–13px; focus rings and control boundaries at least 3:1; inactive text at least 4.5:1, with existing inactive body text kept at 7:1.
- `--cyan` remains the live/Them colour; no theme may reuse it for focus or selection.
- The default Indigo hue stays `#6677FF` for foreground. Solid fills move to `#505BDF` so white labels clear 4.5:1 (current `#6677FF` + white is 3.72:1).
- Existing users with no `appearance` key get Indigo without a migration prompt; a corrupt stored value resolves to Indigo.
- Settings must still fit at 500×480 with seven nav tabs; no horizontal overflow and no clipped tab.

## Design Contract (v1)

### Tokens

| Token | Indigo | Sage | Ember | Role |
|---|---|---|---|---|
| `--accent` | `#6677FF` | `#B3CEB7` | `#FFA477` | foreground text, icons, borders |
| `--accent-hi` | `#7D8AFF` | `#C6DEC9` | `#FFB894` | hover text, gradient start |
| `--accent-soft` | `#C7CEFF` | `#D8E7DB` | `#FFD4BE` | focus ring, soft text |
| `--accent-fill` | `#505BDF` | `#567250` | `#AB572A` | solid filled controls |
| `--accent-fill-hi` | `#5A66E8` | `#5C7A56` | `#B05F31` | gradient top on filled controls; white stays ≥4.5:1 |
| `--accent-ink` | `#FFFFFF` | `#FFFFFF` | `#FFFFFF` | text/icon on `--accent-fill` |
| `--accent-hair` | `rgba(102,119,255,.22)` | `rgba(179,206,183,.20)` | `rgba(255,164,119,.20)` | 1px decorative accent |
| `--accent-wash` | `rgba(102,119,255,.15)` | `rgba(120,170,135,.16)` | `rgba(200,110,60,.16)` | soft selected fill |
| `--accent-glow` | `rgba(102,119,255,.40)` | `rgba(120,180,140,.30)` | `rgba(255,120,60,.32)` | shadow/bloom |
| `--accent-muted` | `#7280C3` | `#8FA891` | `#C98E72` | inactive foreground |
| `--accent-muted-fill` | `#646E9E` | `#626D5F` | `#8B6959` | inactive solid fill and inactive gradient |
| `--accent-muted-hi` | `#7E89D0` | `#9AB39C` | `#D49B7F` | inactive hover/gradient |
| `--accent-muted-soft` | `#ACB0CC` | `#C9DCCC` | `#F0CDBB` | inactive soft/focus |

Measured Indigo/Sage/Ember: white on fill 5.38/5.36/5.09; accent foreground on `#0B1020` 5.09/11.21/9.76; accent-soft 12.35/14.76/13.90. Status hues stay unchanged and all pass against both surfaces.

### Behaviour

- Selecting a theme applies immediately and persists; a failed save reverts the painted theme and the radio selection.
- Inactive-window palettes are per theme. They change accent-family tokens only; shared text dimming remains in the base `body.window-inactive` rule.
- First paint for a saved non-Indigo theme must already use that palette; no Indigo flash.
- `prefers-contrast: more`, `prefers-reduced-transparency`, `forced-colors`, and reduced motion keep their current behaviour; theme rules must not override text/focus colours in those modes.
- The Appearance pane uses native radio inputs, not a custom keyboard widget. Each option has a text label and a selected state.

## Review Focus

- A corrupt or missing persisted theme must resolve to Indigo without throwing, on both store load and first paint.
- A failed `settingsSet` after a theme click must not leave an unsaved palette painted.
- Blurring the window on any theme must dim only accent-family tokens, with no layout movement.
- Seven settings tabs at 500×480 must remain visible and keyboard reachable; the Appearance pane must not be clipped.
- A theme must not leak into status semantics: cyan stays live/Them, warning stays warning, danger stays danger.

---

### Task 1: Shared theme manifest and settings contract

**Files:**
- Create: `src/appearance-themes.js`
- Modify: `src/provider-config.js:152-203` (`getDefaultSettings`)
- Modify: `src/store.js:78-120` (normalise after load), `src/store.js:190-294` (`sanitizeSettingsPatch`)
- Test: `tests/appearance-theme.test.js`

**Interfaces:**
- Produces: `ACCENT_THEMES` (`readonly ['indigo','sage','ember']`), `DEFAULT_ACCENT_THEME = 'indigo'`, `isAccentTheme(value): boolean`.
- Produces: `settings.appearance.theme` from `getDefaultSettings()` and `getPublicSettings()`.

- [ ] **Step 1: Write the failing tests**

Cover: default shape; round trip for each id; partial `{ appearance: {} }` preserves the stored id; unrelated patches preserve it; unknown/case-wrong/empty/number/boolean/null/array values are dropped; prototype-pollution object cannot change the stored id; missing key loads Indigo; corrupt persisted value (`chartreuse`, `appearance: "ember"`, null, `{ theme: 42 }`) loads `{ theme: 'indigo' }`; unknown subkeys are not returned by `getPublicSettings()`; next save self-heals.

- [ ] **Step 2: Run tests and confirm they fail**

Run: `node --test tests/appearance-theme.test.js`
Expected: FAIL because `appearance` and `src/appearance-themes.js` do not exist.

- [ ] **Step 3: Implement the manifest and store changes**

`src/appearance-themes.js` exports the frozen id list, default, and `isAccentTheme`. `getDefaultSettings()` adds `appearance: { theme: DEFAULT_ACCENT_THEME }`. `sanitizeSettingsPatch` accepts only `patch.appearance.theme` when `isAccentTheme` passes and returns `{ appearance: { theme } }`; it must not accept CSS, labels, or arbitrary keys. After `deepMerge(DEFAULTS, settingsOnly)` in `load()`, replace any invalid stored `appearance` with `{ theme: DEFAULT_ACCENT_THEME }` so hand-edited JSON cannot reach the renderer.

- [ ] **Step 4: Run tests and the store suite**

Run: `node --test tests/appearance-theme.test.js tests/store-integrity.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/appearance-themes.js src/provider-config.js src/store.js tests/appearance-theme.test.js
git commit -m "feat: persist the accent theme setting"
```

### Task 2: Split the accent token roles and keep Indigo as the default

**Files:**
- Modify: `renderer/styles.css:3-20` (`:root`)
- Modify: fill sites that currently use `var(--accent)` as a background, including `.user-bubble`, `#send-btn`, `.s-close`, and selected-state gradients.
- Test: `tests/theme-css.test.js`

**Interfaces:**
- Consumes: theme ids from Task 1.
- Produces: tokens in the Design Contract table; `--accent` no longer serves as a solid fill.

- [ ] **Step 1: Write the failing token test**

Assert `:root` declares all ten accent tokens; `--accent` remains `#6677FF`; `--accent-fill` is `#505BDF`; `--accent-ink` is `#FFFFFF`; and no rule besides the declaration block uses `var(--accent)` as `background`/`background-color` for a control that carries white text. Add a static check for the existing focus rule still using `var(--accent-soft)`.

- [ ] **Step 2: Run the test**

Run: `node --test tests/theme-css.test.js`
Expected: FAIL on missing tokens/fill separation.

- [ ] **Step 3: Implement the token split**

Add the Indigo values from the table. Change filled controls to `background: var(--accent-fill)` / `color: var(--accent-ink)`, and gradients to `var(--accent-fill-hi)` → `var(--accent-fill)`. Keep `--accent` for text, icons and borders; keep `--accent-hi` for hover text and tinted selection surfaces; keep `--accent-soft` for focus. Replace accent-tinted rgba literals with `color-mix(in srgb, var(--accent) N%, transparent)` or the new hair/wash tokens.

- [ ] **Step 4: Verify the default is visually stable except for the fill correction**

Run the app, open Settings and the panel, compare screenshots at 100% against `main`; only filled accent surfaces should darken (contrast fix). No layout movement.

- [ ] **Step 5: Commit**

```bash
git add renderer/styles.css tests/theme-css.test.js
git commit -m "refactor: split accent foreground and fill tokens"
```

### Task 3: Remove hardcoded Indigo from component rules

**Files:**
- Modify: `renderer/styles.css` across the 169 accent-bearing declarations listed in `/tmp/vl-theme-css/accent-break.csv`.
- Test: `tests/theme-css.test.js` (source guard)

**Interfaces:**
- Consumes: tokens from Task 2.
- Produces: no `rgba(102,119,255,…)`, `rgba(125,138,255,…)`, `#C7CEFF`, `#D9DCFF`, `#AAB5FF`, `#B5BEFF`, `#a9c8ff`, or `#a072ff` outside the Indigo declaration block.

- [ ] **Step 1: Add the failing source guard**

The test fails while any of those literals appear outside `:root` and the theme blocks. Allow `rgba(199,206,255,…)` as the shared cool glass neutral; do not allow the accent list.

- [ ] **Step 2: Run the guard**

Run: `node --test tests/theme-css.test.js`
Expected: FAIL with the first hardcoded literal.

- [ ] **Step 3: Replace by area**

Work in this order: toolbar and compose, transcript and meeting history, task context, Settings selected/focus states, onboarding and update progress, badges and status pills. Use `--accent`, `--accent-hi`, `--accent-soft`, `--accent-hair`, `--accent-wash`, `--accent-glow` by role. Do not tokenise cyan (`rgba(66,207,232,…)`, `#7DE4F1`, `#bdeeff`) or status colours.

- [ ] **Step 4: Verify**

Run: `node --test tests/theme-css.test.js tests/accent-discipline.test.js`
Expected: PASS; the only remaining indigo literals are in the Indigo block.

- [ ] **Step 5: Commit**

```bash
git add renderer/styles.css tests/theme-css.test.js
git commit -m "refactor: move accent tints onto theme tokens"
```

### Task 4: Add Sage and Ember live palettes with contrast gates

**Files:**
- Modify: `renderer/styles.css` after `:root` (`[data-accent-theme="sage"]`, `[data-accent-theme="ember"]`)
- Test: `tests/theme-css.test.js`

**Interfaces:**
- Consumes: token roles from Task 2.
- Produces: complete Sage/Ember blocks; the default stays unchanged.

- [ ] **Step 1: Write the failing palette tests**

For every id, resolve all ten tokens and assert: `--accent`, `--accent-hi`, `--accent-soft` ≥4.5:1 on `#0B1020` and `#131A2B`; `--accent-ink` on `--accent-fill` and on `--accent-fill-hi` ≥4.5:1; `--accent-soft` on both surfaces ≥3:1; `--accent-muted` ≥4.5:1; white on `--accent-muted-fill` ≥4.5:1; accent hue differs from cyan by ≥30°. Assert Sage/Ember status tokens are untouched.

- [ ] **Step 2: Run tests**

Run: `node --test tests/theme-css.test.js`
Expected: FAIL because the two theme blocks are absent.

- [ ] **Step 3: Add the two blocks**

Use the Design Contract values exactly. Do not change surfaces, text, status, glass, radii or layout.

- [ ] **Step 4: Verify**

Run: `node --test tests/theme-css.test.js`
Expected: PASS for all three palettes.

- [ ] **Step 5: Commit**

```bash
git add renderer/styles.css tests/theme-css.test.js
git commit -m "feat: add sage and ember accent palettes"
```

### Task 5: Apply the saved theme before first paint

**Files:**
- Create: `renderer/theme-boot.js`
- Modify: `renderer/index.html:5-7` (script before stylesheet)
- Modify: `preload.js:3-8` (one `initialAccentTheme` value)
- Modify: `main.js:2821-2855` (trusted sync handler)
- Test: `tests/theme-boot.test.js`

**Interfaces:**
- Produces: `window.volyxLens.initialAccentTheme: string` (validated id, never the settings object).
- Produces: `document.documentElement.dataset.accentTheme` before the first stylesheet paint.

- [ ] **Step 1: Write the failing boot tests**

Assert the head script appears before `styles.css`; it is external, not inline; it accepts only the three ids and defaults to Indigo; preload exposes exactly one string; the main handler uses `isTrustedRenderer(event.sender, event.senderFrame)` and returns Indigo for untrusted senders.

- [ ] **Step 2: Run tests**

Run: `node --test tests/theme-boot.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement the sync read and bootstrap**

Preload calls `ipcRenderer.sendSync('appearance:initial-theme')`. Main registers `ipcMain.on` before window creation, returns `store.getPublicSettings().appearance.theme` for trusted senders and `'indigo'` otherwise. `theme-boot.js` validates against the three ids and sets `document.documentElement.dataset.accentTheme`; if `window.volyxLens` is absent it sets Indigo.

- [ ] **Step 4: Verify cold start per theme**

Run the settings harness with each theme seeded; assert the first animation frame and `dom-ready` computed `--accent` equal the seeded theme, not Indigo. Reload and repeat.

- [ ] **Step 5: Commit**

```bash
git add renderer/theme-boot.js renderer/index.html preload.js main.js tests/theme-boot.test.js
git commit -m "feat: paint the saved accent theme before first paint"
```

### Task 6: Add the Appearance pane

**Files:**
- Modify: `renderer/index.html:210-217` (nav) and after the Context page (new section)
- Modify: `renderer/renderer.js:2482-2497` (`fillSettings` selection), theme change handler near Settings bindings
- Modify: `src/deep-link.js:18` (`SETTINGS_PANES`)
- Modify: `renderer/styles.css` (`.s-theme-group`, swatches, selected state)
- Test: `tests/settings-ui.test.js`, `tests/settings-semantics.test.js`, `tests/deep-link.test.js`, `tests/settings-nav-overflow.test.js`

**Interfaces:**
- Consumes: `settings.appearance.theme`, `data-accent-theme`.
- Produces: native radio group `name="accent-theme"` with values `indigo|sage|ember`; `settingsSet({ appearance: { theme } })` on change.

- [ ] **Step 1: Write the failing UI tests**

Assert a seventh nav button and page titled Appearance; a native `fieldset`/`legend` and three labelled radios; `appearance` in `SETTINGS_PANES`; seven tabs fit at 500×480; selecting a radio updates the attribute and persists; a rejected save restores the previous radio and attribute.

- [ ] **Step 2: Run tests**

Run: `node --test tests/settings-ui.test.js tests/settings-semantics.test.js tests/deep-link.test.js tests/settings-nav-overflow.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement the pane and handler**

Insert the nav entry after Context. The pane says the surface stays dark and only the accent changes. Each option shows a swatch, the theme name, and “Default” on Indigo; do not rely on colour alone. `fillSettings()` checks the stored id. On `change`, set `settings.appearance`, apply `data-accent-theme` immediately, call `settingsSet({ appearance: { theme } })`, and on rejection restore the previous id and radio.

- [ ] **Step 4: Update the settings harness**

Derive the tab count from the DOM instead of asserting six; include `appearance` in the section loop; add a 7-tab compact fit check; assert radio semantics and theme persistence.

- [ ] **Step 5: Commit**

```bash
git add renderer/index.html renderer/renderer.js renderer/styles.css src/deep-link.js tests scripts/check-settings-ui.js
git commit -m "feat: add the appearance settings pane"
```

### Task 7: Per-theme inactive palettes

**Files:**
- Modify: `renderer/styles.css:59-70` (`body.window-inactive`) and add `[data-accent-theme="<id>"] body.window-inactive`
- Modify: `tests/window-inactive-state.test.js`, `tests/accessibility-preferences.test.js`
- Test: `tests/theme-css.test.js`

**Interfaces:**
- Consumes: active tokens from Task 4.
- Produces: inactive `--accent`, `--accent-hi`, `--accent-soft`, `--accent-fill`, `--accent-fill-hi` per theme.

- [ ] **Step 1: Write the failing inactive tests**

For each theme: inactive accent is not the active accent; hue stays within 10°, saturation drops by ≥0.15 or to ≤0.6×, lightness drops by ≥0.03; inactive accent ≥4.5:1 and inactive fill with white ≥4.5:1; text tokens still ≥7:1; no theme inactive block changes layout, type, `--tx-*`, `--surface-*` or status.

- [ ] **Step 2: Run tests**

Run: `node --test tests/window-inactive-state.test.js tests/accessibility-preferences.test.js tests/theme-css.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement inactive blocks**

Replace the literal inactive accent values with token references in the base rule and add one block per theme using the Design Contract inactive values. Keep the existing shared dimming of `--tx-1`, `--tx-2`, `--ic` and status colours. The higher-specificity `prefers-contrast: more` block must remain last.

- [ ] **Step 4: Verify in a real window**

Blur and refocus with each theme; assert the computed inactive/active accents and that no layout rectangle moves.

- [ ] **Step 5: Commit**

```bash
git add renderer/styles.css tests/window-inactive-state.test.js tests/accessibility-preferences.test.js tests/theme-css.test.js
git commit -m "feat: dim accent themes correctly when the window is inactive"
```

### Task 8: Generalise the existing suites and finish the QA surface

**Files:**
- Modify: `tests/accent-discipline.test.js`, `tests/transcript-workspace.test.js`, `tests/settings-ui.test.js`
- Modify: `scripts/check-settings-ui.js`
- Create: `docs/settings-appearance.png`
- Modify: `README.md:61-70,224`, `docs/architecture.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a suite that tests all three themes, not only Indigo.

- [ ] **Step 1: Replace Indigo-only assertions**

Scope default-hex assertions to `:root`; assert selection surfaces use theme tokens; parse the inactive block for each id with a brace-balanced helper; add `appearance` to section loops.

- [ ] **Step 2: Extend the harness**

For each theme: switch, reload, check first frame, check inactive blur/refocus, check computed focus ring is `--accent-soft`, check 7 tabs at 500×480, capture a screenshot via `VOLYX_LENS_SETTINGS_SCREENSHOT_DIR`.

- [ ] **Step 3: Run the full gate**

Run: `npm test && npm run check:settings-ui && npm run check:onboarding-ui`
Expected: PASS; no console errors; no horizontal overflow at 500×480.

- [ ] **Step 4: Update docs and screenshots**

README: three theme names, default unchanged, where to change it, `appearance` in the deep-link pane list. Architecture: `appearance` setting, first-paint bootstrap and why the script is in the head. Regenerate settings screenshots that show the nav; add an Appearance screenshot with all three options labelled.

- [ ] **Step 5: Commit**

```bash
git add tests scripts README.md docs renderer
git commit -m "test: cover all accent themes and document them"
```

### Task 9: Manual matrix and release

**Files:** none.

- [ ] **Step 1: Run the 12-cell matrix on macOS, Windows and Linux**

3 themes × focused/inactive × Settings closed/open. Then per theme: onboarding, streamed answer with retry, meeting history, task context, update progress, cold relaunch. Check no Indigo bleed in Sage/Ember.

- [ ] **Step 2: Run accessibility overlays**

`prefers-contrast: more`, reduced transparency, reduced motion, forced-colors, 125/150% scaling, 200% zoom. Confirm text/focus/selection remain visible and theme switching is instant under reduced motion.

- [ ] **Step 3: Release**

Ship as a minor version. Indigo remains default, so existing installs look unchanged except the darker solid fill required for AA. Stagger Linux → Windows → macOS and announce the picker only after all artifacts exist. Rollback: remove the two new ids from the enum/UI and map stored values to Indigo; older builds deep-merge and ignore `appearance` without data loss.
