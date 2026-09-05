# Performance Optimization Plan for AirSmash

This plan outlines high-impact, zero-breaking-change performance optimizations for AirSmash across 3D rendering, Canvas 2D operations, garbage collection, and asset loading.

## Proposed Changes

### 1. Canvas 2D Confetti & PiP Optimizations

#### [MODIFY] [app.js](file:///Users/Mitesh%20Gada/Documents/Projects/Games/airsmash/app.js)

- **Confetti zero-cost idle path (`stepConfetti`)**:
  - In `stepConfetti(dt)`, the full-screen canvas (e.g. 2560x1440 on retina) is currently cleared via `setTransform` and `clearRect` on *every single animation frame* (60/120fps) even when no confetti is active (`confettiParts.length === 0`).
  - **Optimization**: Guard `stepConfetti` with `if (confettiParts.length === 0) return;`. When active confetti finishes (`performance.now() > confettiUntil`), perform a single clear, reset the array, and return. This completely eliminates idle full-screen clears during matches, serves, and menus.
- **PiP Skeleton drawing batching (`drawSkeletonSlot`)**:
  - Currently makes 21 individual `pc.stroke()` calls (one per bone) and 21 individual `pc.fill()` calls (one per landmark joint), resulting in 42 draw calls per hand (84 draw calls for 2 players) every preview frame.
  - **Optimization**: Connect all bone lines in a single path and stroke once with `pc.stroke()`. Add all joint circle subpaths into one path and fill once with `pc.fill()`. Cuts Canvas 2D draw calls from 42 per hand down to 2.
- **PiP video feed deduplication (`drawPreview`)**:
  - In split 2P mode, `drawFeed` was clipping and drawing the mirrored video twice to the same canvas.
  - **Optimization**: Draw the mirrored video once for the entire preview canvas, then clip and draw each player's skeleton and the central divider line.

---

### 2. Three.js & WebGL Rendering Optimizations

#### [MODIFY] [app.js](file:///Users/Mitesh%20Gada/Documents/Projects/Games/airsmash/app.js)

- **Discrete GPU preference**:
  - In `initThree()`, add `powerPreference: 'high-performance'` to `THREE.WebGLRenderer` options to ensure dual-GPU laptops (MacBook Pro, Windows gaming laptops) use the discrete GPU rather than throttled integrated graphics.
- **Shadow map pass deduplication (2P mode)**:
  - In Three.js, `shadowMap.autoUpdate` defaults to `true`, causing Three.js to re-render the 1024x1024 PCFSoft shadow map from the directional light *on every render call*. In 2 Players mode, `renderScene` calls `r.render` twice per frame (camera 1 near end, camera 2 far end), leading to two shadow map passes per frame.
  - Since the directional light shadow map is camera-independent, set `shadowMap.autoUpdate = false`. In `renderScene`, set `shadowMap.needsUpdate = true` once per animation frame (and skip when paused or idle). The first camera pass computes the shadow map and Three.js automatically clears `needsUpdate = false`, allowing camera 2 to reuse the computed shadow map.
- **Static Scene Graph Optimization (`matrixAutoUpdate = false`)**:
  - Over 25 objects in the scene graph never move after initialization (floor, grid, glow ring, back walls, neon strips, side and far barriers, table legs, apron, boundary lines, and net).
  - Setting `matrixAutoUpdate = false` and calling `updateMatrix()` once on these static objects prevents Three.js from recalculating transformation matrices for 25+ meshes across both render passes on every single frame.

---

### 3. Hand Tracking Pipeline & GC Reduction

#### [MODIFY] [app.js](file:///Users/Mitesh%20Gada/Documents/Projects/Games/airsmash/app.js)

- **In-place ROI coordinate mapping**:
  - In `pumpTracking()`, receiving worker results currently runs `hands.map(...)` and `pts.map(...)`, allocating new arrays and 21+ new `{x, y, z}` objects on every worker frame (up to 30fps).
  - **Optimization**: In-place mutate `p.x` and `p.y` on the existing points in the received worker message. Zero garbage collection churn.
- **Avoid redundant `analyseP1Hand` execution in `updateHandSlot`**:
  - `analyseP1Hand` was being re-run on every animation frame (60fps) even though the underlying landmarks only change when the worker posts a new result (~20fps).
  - Ensure `hand.gesture` is updated when new landmarks are received in `assignPalm` or test seams, avoiding redundant 60fps gesture recalculations.
- **Arm fallback gesture allocation**:
  - In `updateHandSlot` under arm fallback mode, reuse the gesture object rather than allocating `{ powerMul: 1, punch: 0, ... }` every frame.

---

### 4. Network & Asset Preloading

#### [MODIFY] [index.html](file:///Users/Mitesh%20Gada/Documents/Projects/Games/airsmash/index.html)

- Add `<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>` and `<link rel="preconnect" href="https://storage.googleapis.com" crossorigin>` to initiate DNS resolution and TLS handshakes to the MediaPipe bundle and model CDNs immediately on page load.
- Add `<link rel="modulepreload" href="./vendor/three.module.js">` and `<link rel="modulepreload" href="app.js">` to allow browsers to stream and parse ES modules without blocking HTML parsing.

---

## Verification Plan

### Automated Tests
Run the comprehensive verification suite:
```bash
node verify.js
```
Must conclude with `ALL CHECKS PASSED` covering:
- Hermetic flow, 3D scene setup, and WebGL rendering.
- Hand input mapping, speed-adaptive smoothing, and gestures.
- 2-player split screen rendering and two-camera scissoring.
- LAN multiplayer synchronization.
- Performance telemetry (`getPerf()` and `?perf=1` overlay).
- Mobile layout and console error auditing.

Syntax check:
```bash
node --check app.js
```

### Manual / Benchmarking Verification
- Validate via `?perf=1` overlay that `frameEmaMs` stays low and smooth, with zero new `slowFrameCount` or `longtasks` under active play.
- Check that 2 Players split screen mode renders identically with smooth 60fps motion.
- Verify that confetti triggers normally on match point celebration and goes completely idle afterwards.
