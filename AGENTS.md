# AGENTS.md — AirSmash

> Context file for AI agents working on this project. Read this fully before making changes.
> There is **no build step**: plain HTML + CSS + JS (ES module), served statically. Three.js is **vendored** in `vendor/`.

---

## 1. What this is

**AirSmash** is a **first-person 3D table tennis** game (Table Tennis Touch style) with camera motion controls. The camera sits slightly above and behind the player's end of the table; the player sees the full table, the net, and the AI opponent on the far side. A floating paddle tracks the player's real hand (MediaPipe Tasks Vision `HandLandmarker`, in-browser — video never leaves the device). Swinging through the ball returns it. First to 11 (win by 2, sudden-death cap at 15).

**Modes**: *VS AI* (one human vs the bot) and *2 Players* (`state.mode = '2p'`; two humans share one camera but play from **opposite ends of the table** — P1's POV renders in the left half of the screen from the near end, P2's in the right half from the far end via a second camera). Internally P1/P2 reuse the scoring keys `you`/`ai`, so ball physics, scoring and serve rotation are mode-agnostic; only display text differs (`sideLabel()`, `twoPlayer()`).

### Core invariants (never break these)

1. **Coordinate system**: world units are meters. The table is centered at the origin, top surface at `y = TABLE.H (0.76)`. **z: −far … +near**. P1's paddle lives at `z ≈ PADDLE_Z (1.05)`; in 2P, P2 takes the far rail at `PADDLE_Z_FAR (−1.15)`; the AI sits at `z ≈ −1.15`. The net is the plane `z = 0`, top at `NET_TOP (0.9125)`.
2. **Mirroring**: camera x is mirrored — `paddleX ∝ (1 - landmarkX)` — so a hand moves its paddle to that player's right. **P2's x axis flips once more** (`idx === 1 → −1`): they watch a 180°-rotated view, so world −x is their screen-right.
3. **Smoothing**: paddle targets come from a dt-adjusted exponential filter whose rate adapts to raw hand speed (`SMOOTH_SLOW`…`SMOOTH_FAST`, blended by recent speed / `ADAPT_REF_SPEED`) on the palm centroid (landmarks 0, 5, 9, 13, 17). Keep it dt-adjusted so feel is framerate-independent.
4. **Scoring**: the ball must clear the net and land on the receiver's side. Two bounces on the receiver's side, a floor/out touch after a valid bounce, or a never-crossed-net fault ends the point (see `stepBall`). In 2P the "receiver" is the other player on the far rail — `ball.lastHitter` holds a paddle id (`'you'`/`'ai'`) so the same code covers both modes.
5. **Single render pass**: `renderScene()` is the only place that positions 3D objects from state; `syncHud()` is the only place that writes HUD text (and it caches values).
6. **Sound must never break gameplay** — every WebAudio call is try/catch-wrapped.
7. **Inference never blocks the render loop**: MediaPipe runs inside `hand-worker.js`; the main thread only snapshots video frames (`createImageBitmap`, transferred to the worker) and consumes posted results. The synchronous main-thread landmarker exists solely as an automatic fallback when workers fail.

---

## 2. File map

| File | Role |
| --- | --- |
| `index.html` | Single page: hidden `<video id="camera">`, Three.js `<canvas id="game">`, PiP `<canvas id="preview">`, confetti canvas, HUD (score labels are `#score-label-you`/`#score-label-ai`, relabeled P1/P2 in 2P), banner, hand-hint, three screens (intro/setup/error; intro has a `#mode-seg` VS-AI/2-Players toggle and a `#difficulty-block`) and two overlays (pause/gameover). Import map maps `three` → `./vendor/three.module.js`. Loads `app.js` as `<script type="module">`. |
| `vendor/three.module.js` | Vendored Three.js r160 module build (offline-safe renderer). Do not edit; replace wholesale to upgrade. |
| `style.css` | All styling. Design tokens in `:root`. Dark neon arena look. JS only toggles `.hidden`/`.on`/`.in-play` classes and sets the progress-bar width. |
| `app.js` | Entire game (~1800 lines, one ES module file, banner-commented sections). |
| `hand-worker.js` | Module Web Worker owning the MediaPipe `HandLandmarker` (`numHands: 2`). Protocol: `{type:'init'}` → `'ready'`/`'error'`; `{type:'frame', bitmap, ts}` (ImageBitmap transferred in, closed here) → `{type:'result', hands:[[21 {x,y}]], ts}`. Keeps inference off the render thread. Keep its pinned MP version in sync with app.js. |
| `capture.js` | Playwright script (ESM): serves on port 3459, runs `?test=1` with a simulated camera feed + fake hand skeleton(s), saves `screenshots/{intro,setup,gameplay,pause,gameover,twoplayers}.png`. |
| `verify.js` | Playwright script (ESM): serves on port 3458, runs ~75 automated checks (flow, hand input mapping, physics, scoring, pause, persistence, keyboard fallback incl. 2P key split, two-player mode, mobile layout, console errors). **Run this after any gameplay change.** |
| `README.md` | Product narrative + how to play; references the six screenshots. |
| `screenshots/*.png` | Real captures (2x device scale, test mode, software WebGL). Regenerate with `capture.js`. |
| `.gitignore` | Excludes `node_modules/`, `.pw-browsers/`, `.npm-cache/`, `.gh-config/`, `.DS_Store`. |

---

## 3. Game rules & systems

### Table & geometry
- `TABLE = { W: 1.525, L: 2.74, H: 0.76, NET_H: 0.1525, NET_W: 1.72 }` (ITTF proportions, meters). `HALF_W`, `HALF_L`, `NET_TOP` derive from it.
- P1's camera is fixed at `(0, 1.72, 2.35)` looking at `(0, 0.78, -0.55)`; in 2P a second camera (`world.camera2`) sits at the far end `(0, 1.72, −2.35)` looking back, and `renderScene()` draws the scene twice with scissored half-screen viewports (left = P1, right = P2). Each camera sways with its own paddle's x. FOV widens on portrait screens (`layout()`).

### Hand tracking
- `initCameraAndModel()` runs camera + model init in parallel from the setup screen. The worker path tries GPU delegate first inside `hand-worker.js`, automatic CPU fallback there; if the worker itself fails, app.js builds a synchronous main-thread landmarker (same GPU→CPU fallback).
- Per rAF, `pumpTracking(nowMs)`: consumes the newest worker result (`applyTracking`), and when `video.currentTime` changed, snapshots a frame via `createImageBitmap` (one in flight at a time) and transfers it to the worker. In sync-fallback mode it calls `detectForVideo` directly. TEST_MODE short-circuits into `applyFakeHands()`.
- Palm centroid = mean of landmarks `[0, 5, 9, 13, 17]`.
- **Hand→player assignment** (`applyTracking`): greedy nearest-neighbor against each slot's last seen position (`ASSIGN_MEMORY_MS` = 1200); fresh/unmatched hands seed leftmost-mirrored → P1, rightmost → P2. VS-AI mode keeps only the hand closest to P1's previous spot.
- Mapping (mirrored, normalized): `x ∈ [0.10, 0.90]` → paddle x `±PADDLE_X_RANGE (1.05m)` over the full table width; **slot 1 (P2) multiplies by −1** so their on-screen paddle moves with their own 180°-rotated POV; `y ∈ [0.25, 0.90]` → paddle y `PADDLE_Y_TOP (1.62) … PADDLE_Y_BOT (0.82)` for both players. Paddle z is fixed at its rail (`railZ`: `PADDLE_Z` near / `PADDLE_Z_FAR` far) with a small lunge toward the net while swinging fast.
- **Hand lost** > `HAND_LOST_MS` (500ms): that player's paddle coasts, `#hand-hint` appears (names P1/P2 in 2P). No auto-pause.

### Ball physics (`stepBall`)
- Gravity `GRAVITY=12`, table restitution `0.72`, substepped so a fast ball can't tunnel.
- **Net collision**: crossing `z=0` below `NET_TOP` within the net width → the ball dribbles back.
- **Table bounce**: only within the surface bounds; drives the scoring state machine (`bounces`, `validOpponentBounce`, never-crossed fault).
- **Floor / out of arena**: resolves the point (valid bounce → hitter wins; else hitter loses).

### Shot solver (`solveShot`)
- Given launch point, target and speed, computes the initial velocity for a ballistic arc that lands at the target, iterating flight time until the arc clears the net (`NET_TOP + 0.045`). Used by player returns, player serves, AI returns and AI serves.

### Player hitting (`stepPlayerHit`, `playerReturn`)
- Loops over the human paddles (P1 only in VS-AI; P1 + P2 in 2P). Contact when the ball is within `PADDLE_REACH (0.32m)` of a paddle, **on that paddle's side of the net** (near rail: `z > 0.22`; far rail: `z < −0.22`), not hit by that same paddle last (`ball.lastHitter !== paddle.id`), off cooldown. One contact per step.
- Return speed scales with rally length + swing speed; aim x comes from swing direction + randomness, aim z always targets the opponent's half (sign of `pl.z` flipped). In VS-AI a hit also resets the bot's reaction timer and aim error.

### AI opponent (`stepAI`, `aiReturn`)
- `DIFFICULTY` table: `{ speed, react, error, aimAway, returnSpeed }` for easy/normal/hard.
- Predicts the ball's arrival at its rail (with a gravity term), moves at capped speed, and returns via `solveShot` with a per-shot aim error (can push shots wide/long → your point). Hard aims away from the player's paddle.

### Match flow
- Phases: `idle → countdown → serve → rally → point → (serve | over)`.
- **Human serve** (P1, or P2 in 2P): the ball floats beside the server's paddle (`serverPaddle()`); swipe through it (paddle speed > 1.15) or it auto-launches after `AUTO_SERVE_S (4.5s)`.
- **AI serve**: after `AI_SERVE_DELAY (1.3s)`.
- `launchServe()` is the single serve launcher for P1/P2/AI; banner/chip text goes through `showServeBanner()` / `sideLabel()` so it's mode-aware.
- Serve alternates every 2 points; every point at deuce (both ≥ 10). Player 1 serves first.
- `endMatch(winner)` shows the game-over overlay with confetti + fanfare on a win (skipped under `prefers-reduced-motion`). In VS-AI it updates wins/losses; in 2P only best rally is recorded (wins/losses stay a you-vs-AI record).

### Persistence
- `localStorage` key **`airsmash.save.v1`** → `{ sound, difficulty, mode, stats: { wins, losses, bestRally } }`. Saved on difficulty change, mode change, sound toggle, and match end.

### Sound
- Lazy WebAudio `blip(freq, dur, type, gain)` created on first user gesture. Mute toggle in HUD, persisted.

---

## 4. Architecture notes (how `app.js` is organized)

Top-to-bottom sections, each marked with a banner comment:

1. **Constants** — table dimensions, physics tuning, difficulty table, MediaPipe URLs.
2. **State** — single mutable `state` object (no framework, no reactivity).
3. **DOM refs** — `el` object filled by `cacheDom()` on `DOMContentLoaded`.
4. **Layout** — `layout()` (renderer/camera sizing, portrait FOV).
5. **Persistence** — `saveGame()` / `loadGame()`.
6. **Screen flow** — `showScreen(name)` toggles every screen/overlay/HUD/PiP from `state.screen` + `state.paused` + `state.phase`.
7. **Camera & tracking** — `initCameraAndModel()`, `initCamera()`, `initHandModel()` (worker-first, sync fallback), `pumpTracking()`, `applyTracking()`, `applyFakeHands()`.
8. **Hand input** — `updateHandInput(dt)` / `updateKeyboardInput(dt)` → `updateHandSlot()` / `drivePaddleKeyboard()` → `movePaddle(paddle, keysPad, dt)` (also computes swing velocity); `updateHandHints()` writes the nudge.
9. **3D scene** — `initThree()` (also builds the second POV camera `world.camera2`), `buildArena()` (incl. the mirrored back wall behind P1's camera for P2's view), `buildTable()`, `buildBall()`, `buildPaddle()` (also builds the hidden P2 paddle), `buildOpponent()`.
10. **Match flow** — `resetMatch()`, `startMatch()`, `beginServe()`, `showServeBanner()`, `launchServe()` (unified for P1/P2/AI), `scorePoint()`, `afterPoint()`, `endMatch()`, plus mode helpers `twoPlayer()`, `sideLabel()`, `syncModeUi()`, `setMode()`, `syncScoreLabels()`, `syncOpponentVisibility()`.
11. **Shot solver** — `solveShot()`.
12. **Ball physics** — `stepBall(dt, scoring)`.
13. **Player hitting** — `nearSidePaddles()`, `stepPlayerHit(dt)`, `playerReturn(pl)`.
14. **AI opponent** — `stepAI(dt)`, `aiReturn()`.
15. **Rendering** — `renderScene(dt)` (paddles, ball, shadow, trail; in 2P draws the scene twice into scissored half-screen viewports via `world.camera2` — left P1, right P2 — otherwise a single full-viewport pass), `drawPreview()` (PiP; split into P1/P2 halves with labels in 2P), `syncHud()`.
16. **Banner / Toast** — `showBanner()`, `hideBanner()`, `toast()`.
17. **Sound** — `blip()`, `toggleSound()`.
18. **Confetti** — `spawnConfetti()`, `stepConfetti(dt)` on the overlay canvas.
19. **Wiring** — all buttons + keyboard + visibilitychange auto-pause.
20. **Main loop** — `frame(ts)` with dt clamped to 50ms.
21. **Test seam** — `window.__airsmash` (see below).

### Invariants to respect when editing
- `renderScene()` must stay idempotent and the only place that positions 3D objects from state.
- All event handling is wired once in `wireControls()` — don't attach per-frame listeners.
- Keep the file dependency-free (only `import * as THREE from 'three'` via the import map, plus the pinned CDN MediaPipe bundle).
- `package.json` is `"type": "module"` — `app.js`, `verify.js`, `capture.js` are all ESM.
- **HTML gotcha (fixed bug — don't regress)**: the favicon `href` must be a *percent-encoded* data URI. A raw `<svg>` inside the attribute breaks HTML parsing and silently swallows the `<script type="importmap">` tag, which makes `import 'three'` fail.

---

## 5. Test seam (`window.__airsmash`)

Exposed only for tooling; harmless in production. `?test=1` makes the app hermetic: no real camera, no model download, fake video.

| Method | Effect |
| --- | --- |
| `setFakeHand(x, y)` | Pretend one hand is at normalized mirrored coords (x 0..1 left→right, y 0..1 top→bottom); feeds P1's slot. |
| `setFakeHands(list)` | Fake N hands at once: index 0 → P1, index 1 → P2 (two-player mode needs both). |
| `clearFakeHand()` | Remove all fake hands. |
| `setFakeLandmarks(pts, slot = 0)` | Inject a fake skeleton (array of 21 `{x, y}` unmirrored points); optional second arg selects the hand slot for the PiP overlay. |
| `setFakeBackground(canvas)` | Use an offscreen canvas as a simulated camera feed (capture.js). |
| `skipCountdown()` | End the match-start countdown immediately. |
| `serveNow()` | Launch the current serve immediately (whichever side). |
| `forceScore(side)` | Award a point to `'you'` or `'ai'` (= P2 in 2P) as if the rally had ended. |
| `placeBall(x, y, z, vx, vy, vz, lastHitter)` | Position the ball mid-rally (screenshots / physics tests). |
| `finishMatch(winner)` | Fast-forward the match to game over. |

Also exposed: `state` (incl. `mode`, `hand`, `hand2`, `player`, `p2`), `TABLE`, `view`, `renderer` / `camera` / `camera2` (getters).

---

## 6. Visual design system (`style.css`)

- **Tokens** in `:root`: palette (`--bg` deep navy, `--accent` neon green = player, `--accent-2` hot pink = AI, `--gold`, `--cyan`), fonts (Chakra Petch display + Inter UI), radii, shadows.
- **Aesthetic**: dark neon arena (Three.js): blue ITTF table with white lines, net with posts, glowing floor ring, barrier boards, cyan/pink rim lights, an AI opponent with a glowing visor. HUD is glassy chips over the 3D view.
- **PiP preview** (`#preview`): mirrored camera feed + hand skeleton. Centered and large on the setup screen (`.setup-top` reserves space for it via `margin-top`); small in the bottom-left corner during play (`.in-play`). In 2P it splits into two clipped halves (P1 left/cyan, P2 right/orange, with labels) and gains `.split` so it straddles the seam between the two POVs.
- **Screens** are fixed overlays toggled with `.hidden`; setup screen is transparent so the arena shows behind.
- **Responsive**: HUD condenses ≤640px; compact layout for landscape phones (max-height 480px); `(hover: none)` enlarges touch targets; `prefers-reduced-motion` disables animation; safe-area insets respected.

---

## 7. Tooling & environment

### Running the game
```bash
python3 -m http.server 8000   # any static server works; open http://localhost:8000
```
Camera access requires `localhost` or HTTPS. Internet needed on first load (CDN hand-tracking model). Three.js is vendored, so the renderer itself works offline.

### Screenshots & tests (Playwright)
```bash
node capture.js    # regenerates screenshots/*.png
node verify.js     # automated playthrough; must end with "ALL CHECKS PASSED"
```

**Environment constraints (important):**
- This machine runs **macOS 12.7.6**. Playwright ≥ 1.46 refuses to install Chromium here. The project is pinned to **`playwright@1.45.1`** — do not upgrade it.
- Tooling lives **outside the repo**, in `../../Do not delete folder/` (i.e. `~/Documents/Projects/Do not delete folder/`): shared `.pw-browsers/` (Chromium 1124), shared `node_modules/` (playwright 1.45.1), and `.npm-cache/`. Both scripts set `process.env.PLAYWRIGHT_BROWSERS_PATH` to the shared browsers **only when that folder exists**; on a fresh clone they fall back to Playwright's default browser location (`npm install && npx playwright install chromium`). The project's `node_modules` here is a **symlink** to the shared one (not committed).
- If the shared `chromium-1124` is missing: `npm install --cache "$PWD/../../Do not delete folder/.npm-cache"` then `PLAYWRIGHT_BROWSERS_PATH="$PWD/../../Do not delete folder/.pw-browsers" npx playwright install chromium`.
- **WebGL in headless Chromium**: both scripts launch with `--enable-unsafe-swiftshader` (software WebGL). Without it the renderer fails to initialize headless.
- The local agent model **cannot view images** — verify visual changes via `verify.js` measurements (state values, bounding boxes), not by "looking" at screenshots.
- `verify.js` uses port **3458**, `capture.js` uses port **3459** (loom uses 3456/3457 — don't collide).

### Git
- Repo on branch `main`. Caches gitignored. Remote/upload is handled by the user.

---

## 8. Recipes for common changes

**Tune difficulty**: edit the `DIFFICULTY` table (`speed` m/s, `react` s, `error` m, `aimAway` bool, `returnSpeed` m/s).

**Change match rules**: `WIN_SCORE`, `WIN_BY`, `SCORE_CAP` constants; serve logic lives in `currentServer()`.

**Adjust hand feel**: `SMOOTH_SLOW`/`SMOOTH_FAST` (adaptive filter rate bounds — raise FAST for snappier swings), `ADAPT_REF_SPEED` (raw speed that maps to the fast end), `HAND_X_MIN/MAX`, `HAND_Y_MIN/MAX` (mapping range), `PADDLE_X_RANGE`, `PADDLE_Y_TOP/BOT`, `PADDLE_REACH` (hit radius), `HAND_LOST_MS`, `ASSIGN_MEMORY_MS` (hand→player stickiness).

**Tune two-player mode**: `PADDLE_Z_FAR` (P2's far rail), the P2 x-flip in `updateHandSlot()` / `drivePaddleKeyboard()`, the per-side hit gate in `stepPlayerHit()`, serve direction in `launchServe()` (sign of `sp.z`), the split-screen pass in `renderScene()` (`world.camera2`, scissored viewports), and the keyboard split in `wireControls()` (pad1 = WASD+Space, pad2 = Arrows+Enter).

**Change ball physics**: `GRAVITY`, `RESTITUTION`, `BALL_R`, power scaling in `playerReturn()` / `aiReturn()`, net clearance margin in `solveShot()`.

**Move the camera**: `world.camera.position` / `lookAt` in `initThree()` and the sway in `renderScene()`; portrait FOV in `layout()`.

**Add a control/button**: add markup in `index.html`, style in `style.css`, register the id in `cacheDom()`'s `ids` array, wire it in `wireControls()`. If it mutates state, call `saveGame()` if it should persist.

**Upgrade Three.js**: download the new `three.module.js` build into `vendor/` (replace wholesale) and re-test.

**Upgrade MediaPipe**: bump `MP_VERSION` and re-test; the model URL is version-independent.

---

## 9. Definition of done for any change

1. `node --check app.js` passes.
2. `node verify.js` ends with **ALL CHECKS PASSED** (extend it when you add behavior).
3. `node capture.js` run if visuals changed, so README screenshots stay honest.
4. No new runtime dependencies; no build step introduced.
