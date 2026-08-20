# AGENTS.md — AirSmash

> Context file for AI agents working on this project. Read this fully before making changes.
> There is **no build step**: plain HTML + CSS + JS (ES module), served statically.

---

## 1. What this is

**AirSmash** is a camera hand-tracked air table tennis game. The player moves their real hand in front of the device camera; MediaPipe Tasks Vision (`HandLandmarker`) tracks the palm in-browser (video never leaves the device), and a paddle mirrors the hand across the player's half of a top-down table. The opponent is a difficulty-scaled AI. First to 11 (win by 2, sudden-death cap at 15).

### Core invariants (never break these)

1. **Mirroring**: camera x is mirrored — `paddleX ∝ (1 - landmarkX)` — so the player's right hand moves the paddle right.
2. **Smoothing**: paddle targets come from an exponential filter `alpha = 1 - exp(-dt * SMOOTH_RATE)` on the palm centroid (landmarks 0, 5, 9, 13, 17). Keep it dt-adjusted so feel is framerate-independent.
3. **Player's half only**: the paddle y is clamped between `table.netY + 26` and `table.bottomY - 14`.
4. **Scoring**: ball past the top endline = player point; past the bottom endline = AI point. First to 11, win by 2, hard cap 15.
5. **Single render pass**: `render()` is the only place that draws to the game canvas from state; `syncHud()` is the only place that writes HUD text (and it caches values).
6. **Sound must never break gameplay** — every WebAudio call is try/catch-wrapped.

---

## 2. File map

| File | Role |
| --- | --- |
| `index.html` | Single page: hidden `<video id="camera">`, game + confetti canvases, HUD, banner, hand-hint, four screens (intro/setup/error) and two overlays (pause/gameover). Loads `app.js` as `<script type="module">`. |
| `style.css` | All styling. Design tokens in `:root`. Dark neon arena look. JS only toggles `.hidden`/`.on` classes and sets the progress-bar width. |
| `app.js` | Entire game (~1100 lines, one ES module file, banner-commented sections). |
| `capture.js` | Playwright script (ESM): serves on port 3459, runs `?test=1` with a simulated camera feed + fake hand skeleton, saves `screenshots/{intro,setup,gameplay,pause,gameover}.png`. |
| `verify.js` | Playwright script (ESM): serves on port 3458, runs ~50 automated checks (flow, hand input mapping, physics, scoring, pause, persistence, keyboard fallback, mobile layout, console errors). **Run this after any gameplay change.** |
| `README.md` | Product narrative + how to play; references the five screenshots. |
| `screenshots/*.png` | Real captures (2x device scale, test mode). Regenerate with `capture.js`. |
| `.gitignore` | Excludes `node_modules/`, `.pw-browsers/`, `.npm-cache/`, `.gh-config/`, `.DS_Store`. |

---

## 3. Game rules & systems

### Table & geometry
- `layout()` computes the table from the viewport: portrait → width-limited, landscape → height-limited (aspect 1 : 1.42). All positions derive from `table.{x,y,w,h,netY,bottomY}` — never hardcode pixel positions.
- Ball radius `BALL_R=9`; paddles `PADDLE_W=118 × PADDLE_H=20`.

### Hand tracking
- `initCameraAndModel()` runs camera + model init in parallel from the setup screen. GPU delegate first, automatic CPU fallback.
- `detectFrame(nowMs)` runs once per rAF: `landmarker.detectForVideo(video, nowMs)`, guarded by `video.currentTime` change.
- Palm centroid = mean of landmarks `[0, 5, 9, 13, 17]`.
- Mapping (mirrored, normalized): `x ∈ [0.08, 0.92]` → full table width (6% overshoot allowed); `y ∈ [0.30, 0.95]` → player's half.
- **Hand lost** > `HAND_LOST_MS` (500ms): paddle coasts, `#hand-hint` appears. No auto-pause.

### Physics
- `stepPhysics(dt)` substeps so a fast ball can't tunnel (`steps = ceil(speed*dt / (BALL_R*0.9))`).
- Paddle hit: angle from hit position on the face (max 62°), plus spin from paddle velocity (`SPIN_FACTOR`), speed × `BALL_SPEEDUP` per hit capped at `BALL_SPEED_MAX`.
- Side walls reflect; endlines score.

### AI
- `DIFFICULTY` table: `{ speed, react, error, aimAway }` for easy/normal/hard.
- AI predicts the ball's landing x at its rail (with wall reflections), adds a per-shot Gaussian-ish aim error, and moves at capped speed. Hard biases returns away from the player's paddle.

### Match flow
- Phases: `idle → serve → rally → point → (serve | over)`.
- Serve alternates every 2 points; every point at deuce (both ≥ 10). Player serves first.
- `endMatch(winner)` updates `state.stats`, saves, shows the game-over overlay, confetti + fanfare on a win (skipped under `prefers-reduced-motion`).

### Persistence
- `localStorage` key **`airsmash.save.v1`** → `{ sound, difficulty, stats: { wins, losses, bestRally } }`. Saved on difficulty change, sound toggle, and match end.

### Sound
- Lazy WebAudio `blip(freq, dur, type, gain)` created on first user gesture. Mute toggle in HUD, persisted.

---

## 4. Architecture notes (how `app.js` is organized)

Top-to-bottom sections, each marked with a banner comment:

1. **Constants** — geometry, physics tuning, difficulty table, MediaPipe URLs.
2. **State** — single mutable `state` object (no framework, no reactivity).
3. **DOM refs** — `el` object filled by `cacheDom()` on `DOMContentLoaded`.
4. **Layout** — `layout()` (canvas sizing + table geometry), `clampPaddles()`.
5. **Persistence** — `saveGame()` / `loadGame()`.
6. **Screen flow** — `showScreen(name)` toggles every screen/overlay/HUD from `state.screen` + `state.paused` + `state.phase`.
7. **Camera & tracking** — `initCameraAndModel()`, `initCamera()`, `initHandModel()`, `detectFrame()`.
8. **Hand input** — `updateHandInput(dt)` / `updateKeyboardInput(dt)` → `movePlayerPaddle(dt)`.
9. **Match flow** — `resetMatch()`, `startMatch()`, `startServe()`, `launchBall()`, `scorePoint()`, `afterPoint()`, `endMatch()`.
10. **Physics** — `stepPhysics(dt)`, `paddleHit()`.
11. **AI** — `stepAI(dt)`.
12. **Rendering** — `render()` single pass: background → table → skeleton → ball → paddles → `syncHud()`.
13. **Banner / Toast** — `showBanner()`, `hideBanner()`, `toast()`.
14. **Sound** — `blip()`, `toggleSound()`.
15. **Confetti** — `spawnConfetti()`, `stepConfetti(dt)` on the overlay canvas.
16. **Wiring** — all buttons + keyboard + visibilitychange auto-pause.
17. **Main loop** — `frame(ts)` with dt clamped to 50ms.
18. **Test seam** — `window.__airsmash` (see below).

### Invariants to respect when editing
- `render()` must stay idempotent and the only place that draws from state.
- All event handling is wired once in `wireControls()` — don't attach per-frame listeners.
- Keep the file dependency-free (no imports except the pinned CDN MediaPipe bundle).
- `package.json` is `"type": "module"` — `app.js`, `verify.js`, `capture.js` are all ESM.

---

## 5. Test seam (`window.__airsmash`)

Exposed only for tooling; harmless in production. `?test=1` makes the app hermetic: no real camera, no model download, fake video.

| Method | Effect |
| --- | --- |
| `setFakeHand(x, y)` | Pretend a hand is at normalized mirrored coords (x 0..1 left→right, y 0..1 top→bottom). |
| `clearFakeHand()` | Remove the fake hand. |
| `setFakeLandmarks(pts)` | Inject a fake skeleton (array of 21 `{x, y}` unmirrored points). |
| `setFakeBackground(canvas)` | Use an offscreen canvas as a simulated camera feed (capture.js). |
| `skipCountdown()` | End the serve countdown immediately. |
| `forceScore(side)` | Award a point to `'you'` or `'ai'` as if the ball crossed the endline. |
| `finishMatch(winner)` | Fast-forward the match to game over. |

Also exposed: `state`, `table`, `view`.

---

## 6. Visual design system (`style.css`)

- **Tokens** in `:root`: palette (`--bg` deep navy, `--accent` neon green = player, `--accent-2` hot pink = AI, `--gold`, `--cyan`), fonts (Chakra Petch display + Inter UI), radii, shadows.
- **Aesthetic**: dark sports arena; camera feed drawn mirrored + dimmed behind a semi-opaque blue table with glowing white lines and a net band; neon paddles; ball with glow + trail.
- **Screens** are fixed overlays toggled with `.hidden`; setup screen is transparent so the canvas preview shows through.
- **Responsive**: HUD condenses ≤640px; compact layout for landscape phones (max-height 480px); `(hover: none)` enlarges touch targets; `prefers-reduced-motion` disables animation; safe-area insets respected.

---

## 7. Tooling & environment

### Running the game
```bash
python3 -m http.server 8000   # any static server works; open http://localhost:8000
```
Camera access requires `localhost` or HTTPS. Internet needed on first load (CDN model).

### Screenshots & tests (Playwright)
```bash
node capture.js    # regenerates screenshots/*.png
node verify.js     # automated playthrough; must end with "ALL CHECKS PASSED"
```

**Environment constraints (important):**
- This machine runs **macOS 12.7.6**. Playwright ≥ 1.46 refuses to install Chromium here. The project is pinned to **`playwright@1.45.1`** — do not upgrade it.
- Tooling lives **outside the repo**, in `../../Do not delete folder/` (i.e. `~/Documents/Projects/Do not delete folder/`): shared `.pw-browsers/` (Chromium 1124), shared `node_modules/` (playwright 1.45.1), and `.npm-cache/`. Both scripts set `process.env.PLAYWRIGHT_BROWSERS_PATH` to the shared browsers; the project's `node_modules` is a **symlink** to the shared one.
- If the shared `chromium-1124` is missing: `npm install --cache "$PWD/../../Do not delete folder/.npm-cache"` then `PLAYWRIGHT_BROWSERS_PATH="$PWD/../../Do not delete folder/.pw-browsers" npx playwright install chromium`.
- The local agent model **cannot view images** — verify visual changes via `verify.js` measurements (bounding boxes, state values), not by "looking" at screenshots.
- `verify.js` uses port **3458**, `capture.js` uses port **3459** (loom uses 3456/3457 — don't collide).

### Git
- Repo on branch `main`. Caches gitignored. Remote/upload is handled by the user.

---

## 8. Recipes for common changes

**Tune difficulty**: edit the `DIFFICULTY` table (`speed` px/s, `react` s, `error` px, `aimAway` bool).

**Change match rules**: `WIN_SCORE`, `WIN_BY`, `SCORE_CAP` constants; serve logic lives in `currentServer()`.

**Adjust hand feel**: `SMOOTH_RATE` (higher = snappier), `HAND_X_MIN/MAX`, `HAND_Y_MIN/MAX` (mapping range), `HAND_LOST_MS`.

**Change ball physics**: `BALL_SPEED_BASE/MAX`, `BALL_SPEEDUP`, `SPIN_FACTOR`, max angle in `paddleHit()`.

**Add a control/button**: add markup in `index.html`, style in `style.css`, register the id in `cacheDom()`'s `ids` array, wire it in `wireControls()`. If it mutates state, call `saveGame()` if it should persist.

**Change table aspect/size**: edit `layout()` — everything else derives from `table`.

**Upgrade MediaPipe**: bump `MP_VERSION` and re-test; the model URL is version-independent.

---

## 9. Definition of done for any change

1. `node --check app.js` passes.
2. `node verify.js` ends with **ALL CHECKS PASSED** (extend it when you add behavior).
3. `node capture.js` run if visuals changed, so README screenshots stay honest.
4. No new runtime dependencies; no build step introduced.
