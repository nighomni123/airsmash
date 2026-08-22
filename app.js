/* ============================================================
   AirSmash — app.js  (3D first-person table tennis)
   Your hand is the paddle. Camera behind your end of the table,
   full view of the net, the opponent and the arena.
   Two-player mode: two hands, two paddles on the near rail
   (P1 left half, P2 right half) sharing one camera.

   Sections (banner-commented, top to bottom):
     1. Constants        — table dimensions, physics, difficulty
     2. State            — single mutable state object
     3. DOM refs         — cacheDom()
     4. Layout           — renderer/camera sizing
     5. Persistence      — localStorage save/load
     6. Screen flow      — showScreen(), overlays
     7. Camera & tracking— getUserMedia + HandLandmarker in a worker
                           (hand-worker.js) with sync main-thread fallback
     8. Hand input       — mirror, map to 3D paddles, swing velocity
     9. 3D scene         — arena, table, net, paddles, ball (Three.js)
    10. Match flow       — reset, serve, score, win
    11. Shot solver      — ballistic aim with net clearance
    12. Ball physics     — gravity, table bounce, net, out of bounds
    13. Player hitting   — swing detection + returns (both players)
    14. AI opponent      — prediction, movement, returns, serves
    15. Rendering        — render pass, PiP preview, HUD sync
    16. Banner / Toast
    17. Sound            — lazy WebAudio blips
    18. Confetti
    19. Wiring           — buttons + keyboard
    20. Main loop
    21. Test seam        — window.__airsmash (used by verify/capture)
   ============================================================ */

'use strict';

import * as THREE from 'three';

/* ============================================================
   1. CONSTANTS
   ============================================================ */

const SAVE_KEY = 'airsmash.save.v1';

// MediaPipe Tasks Vision (pinned). Internet needed on first load; cached after.
const MP_VERSION = '0.10.14';
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MP_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Hand → paddle mapping (normalized camera coords, AFTER mirroring).
const HAND_X_MIN = 0.10, HAND_X_MAX = 0.90;
const HAND_Y_MIN = 0.25, HAND_Y_MAX = 0.90;

// Speed-adaptive smoothing (one-euro style): a slow hand is filtered
// hard (stable paddle), a fast swing barely at all (no input lag).
// Rate = exp-filter rate per second; alpha = 1 - exp(-dt * rate).
const SMOOTH_SLOW = 9, SMOOTH_FAST = 36;
const ADAPT_REF_SPEED = 0.85;                  // normalized units/sec that maps to the fast end

const HAND_LOST_MS = 500;                      // grace before "show your hand"
const ASSIGN_MEMORY_MS = 1200;                 // how long a slot remembers its last hand position

// Paddle workspace (world meters). P1 lives on the near rail (+z); in
// two-player, P2 takes the far rail (−z) — real opposite-ends play.
const PADDLE_X_RANGE = 1.05;
const PADDLE_Y_TOP = 1.62, PADDLE_Y_BOT = 0.82;
const PADDLE_Z = 1.05;                         // near rail (P1 / the human in VS-AI)
const PADDLE_Z_FAR = -1.15;                    // far rail (P2 in two-player)
const PADDLE_REACH = 0.32;                     // hit radius around the paddle

// Table (ITTF proportions, in meters). z: -far … +near (player at +z).
const TABLE = {
  W: 1.525, L: 2.74, H: 0.76,
  NET_H: 0.1525, NET_W: 1.72,
};
const HALF_W = TABLE.W / 2;
const HALF_L = TABLE.L / 2;
const NET_TOP = TABLE.H + TABLE.NET_H;

// Ball physics.
const BALL_R = 0.045;                          // slightly oversized for visibility
const GRAVITY = 12.0;                          // snappier than real gravity
const RESTITUTION = 0.72;                      // table bounce
const FLOOR_RESTITUTION = 0.45;

// Serving.
const SERVE_SPEED = 2.6;
const AUTO_SERVE_S = 4.5;                      // your serve auto-launches after this
const AI_SERVE_DELAY = 1.3;

// Match rules.
const WIN_SCORE = 11;
const WIN_BY = 2;
const SCORE_CAP = 15;                          // sudden death beyond this
const COUNTDOWN_STEP = 0.6;                    // seconds per countdown number
const POINT_TIME = 1.35;                       // banner time between points

// Difficulty table: AI paddle speed, reaction delay, aim error (m), targeting.
const DIFFICULTY = {
  easy:   { label: 'Easy',   speed: 1.15, react: 0.24, error: 0.50, aimAway: false, returnSpeed: 2.3 },
  normal: { label: 'Normal', speed: 1.75, react: 0.15, error: 0.28, aimAway: false, returnSpeed: 2.7 },
  hard:   { label: 'Hard',   speed: 2.45, react: 0.08, error: 0.13, aimAway: true,  returnSpeed: 3.1 },
};

// Hand skeleton connections (MediaPipe landmark indices).
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
const PALM_IDX = [0, 5, 9, 13, 17];            // stable palm centroid

const KEY_SPEED = 1.7;                         // keyboard fallback m/s
const PREVIEW_INTERVAL_MS = 33;                // PiP redraw cap (~30fps saves main-thread time)

const TEST_MODE = new URLSearchParams(location.search).has('test');
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ============================================================
   2. STATE
   ============================================================ */

const state = {
  screen: 'intro',           // intro | setup | error | play
  phase: 'idle',             // idle | countdown | serve | rally | point | over
  paused: false,
  difficulty: 'normal',
  inputMode: 'hand',         // hand | keyboard
  mode: 'ai',                // ai = vs AI (P1 only) | 2p = two human players

  // Match
  scoreYou: 0,
  scoreAI: 0,
  rally: 0,
  longestRally: 0,
  serveSide: 'you',          // you | ai   ('ai' key = player 2 in 2p mode)
  serveTimer: 0,
  timer: 0,                  // countdown / point-phase timer
  lastCountdown: -1,
  lastPointWinner: null,

  // Ball
  ball: {
    x: 0, y: 1.0, z: 0.8,
    vx: 0, vy: 0, vz: 0,
    lastHitter: null,        // you | ai
    bounces: 0,              // bounces since last hit
    validOpponentBounce: false,
    visible: true,
  },

  // Near/far paddles. Internal ids match the scoring keys:
  // player.id='you' (player 1, near rail), p2.id='ai' (player 2 in 2p,
  // far rail), ai.id='ai' (the bot). Scoring/HUD code never needs to know.
  player: { id: 'you', x: 0, y: 1.1, z: PADDLE_Z, railZ: PADDLE_Z, vx: 0, vy: 0, vz: 0, speed: 0, targetX: 0, targetY: 1.1, hitCooldown: 0 },
  p2:      { id: 'ai',  x: 0, y: 1.0, z: PADDLE_Z_FAR, railZ: PADDLE_Z_FAR, vx: 0, vy: 0, vz: 0, speed: 0, targetX: 0, targetY: 1.0, hitCooldown: 0 },
  ai: { id: 'ai', x: 0, y: 1.0, z: -1.15, vx: 0, targetX: 0, targetY: 1.0, hitCooldown: 0, reactT: 0, aimErrX: 0, aimErrZ: 0 },

  // Hand tracking — one slot per player (slot 1 only used in 2p mode).
  hand: makeHandSlot(),
  hand2: makeHandSlot(),
  fakeHands: null,           // test seam: [{ x, y }, …] normalized mirrored coords
  fakeBackground: null,      // test seam: canvas used as simulated camera feed

  // Setup
  cameraReady: false,
  modelReady: false,

  // Meta
  sound: true,
  stats: { wins: 0, losses: 0, bestRally: 0 },
};

function makeHandSlot() {
  return {
    detected: false,
    everDetected: false,
    lostMs: 0,
    rawX: 0.5, rawY: 0.7,    // normalized, mirrored
    smX: 0.5, smY: 0.7,      // smoothed normalized
    motion: 0,               // short-average raw speed (normalized/s) → adaptive smoothing
    prevRawX: 0.5, prevRawY: 0.7,
    assignX: 0.5, assignY: 0.7, // last seen palm position (for hand→player assignment)
    lastSeenMs: -1e9,
    landmarks: null,         // latest raw (unmirrored) landmarks, for skeleton
  };
}

// Keyboard state — two pads so both players can play on one keyboard.
// pad1: WASD + Space (arrows merge into pad1 in single-player mode).
// pad2: Arrows + Enter (two-player mode).
const pad1Keys = { left: false, right: false, up: false, down: false, swing: 0 };
const pad2Keys = { left: false, right: false, up: false, down: false, swing: 0 };

/* ============================================================
   3. DOM REFS
   ============================================================ */

const el = {};

function cacheDom() {
  const ids = [
    'camera', 'game', 'preview', 'confetti', 'hud', 'score-you', 'score-ai',
    'score-label-you', 'score-label-ai',
    'rally-count', 'serve-chip', 'btn-sound', 'btn-pause',
    'banner', 'banner-text', 'banner-sub', 'hand-hint',
    'screen-intro', 'screen-setup', 'screen-error',
    'overlay-pause', 'overlay-gameover', 'toast',
    'mode-seg', 'mode-hint', 'difficulty-block',
    'difficulty-seg', 'btn-start', 'stat-wins', 'stat-losses', 'stat-rally',
    'setup-status', 'setup-progress', 'setup-progress-bar',
    'btn-start-match', 'btn-keyboard-mode',
    'error-title', 'error-msg', 'btn-retry', 'btn-error-keyboard', 'btn-error-menu',
    'btn-resume', 'btn-restart', 'btn-quit',
    'gameover-emoji', 'gameover-title', 'gameover-score',
    'gameover-rally', 'gameover-diff',
    'btn-rematch', 'btn-change-diff', 'btn-menu',
  ];
  for (const id of ids) el[id] = document.getElementById(id);
}

/* ============================================================
   4. LAYOUT
   ============================================================ */

const view = { w: 0, h: 0, dpr: 1 };

function layout() {
  view.w = window.innerWidth;
  view.h = window.innerHeight;
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (world.renderer) {
    world.renderer.setPixelRatio(view.dpr);
    world.renderer.setSize(view.w, view.h);
    world.camera.aspect = view.w / view.h;
    // Widen FOV on portrait screens so the whole table stays visible.
    world.camera.fov = view.w / view.h < 0.8 ? 72 : 58;
    world.camera.updateProjectionMatrix();
  }
  const cc = el.confetti;
  cc.width = Math.round(view.w * view.dpr);
  cc.height = Math.round(view.h * view.dpr);
}

/* ============================================================
   5. PERSISTENCE
   ============================================================ */

function saveGame() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      sound: state.sound,
      difficulty: state.difficulty,
      mode: state.mode,
      stats: state.stats,
    }));
  } catch { /* storage unavailable — ignore */ }
}

function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (typeof data.sound === 'boolean') state.sound = data.sound;
    if (data.difficulty && DIFFICULTY[data.difficulty]) state.difficulty = data.difficulty;
    if (data.mode === 'ai' || data.mode === '2p') state.mode = data.mode;
    if (data.stats && typeof data.stats === 'object') {
      state.stats.wins = data.stats.wins | 0;
      state.stats.losses = data.stats.losses | 0;
      state.stats.bestRally = data.stats.bestRally | 0;
    }
  } catch { /* corrupt save — start fresh */ }
}

/* ============================================================
   6. SCREEN FLOW
   ============================================================ */

function showScreen(name) {
  state.screen = name;
  el['screen-intro'].classList.toggle('hidden', name !== 'intro');
  el['screen-setup'].classList.toggle('hidden', name !== 'setup');
  el['screen-error'].classList.toggle('hidden', name !== 'error');
  el['overlay-pause'].classList.toggle('hidden', !(name === 'play' && state.paused));
  el['overlay-gameover'].classList.toggle('hidden', !(name === 'play' && state.phase === 'over'));
  el.hud.classList.toggle('hidden', name !== 'play');

  const showPreview = state.inputMode === 'hand' && (name === 'setup' || name === 'play');
  el.preview.classList.toggle('hidden', !showPreview);
  el.preview.classList.toggle('in-play', name === 'play');
  el.preview.classList.toggle('split', twoPlayer());

  if (name !== 'play') {
    el['hand-hint'].classList.add('hidden');
    el.banner.classList.add('hidden');
  }
}

// Display names for the two sides, per mode. Internal keys stay
// 'you'/'ai' everywhere (scoring, ball.lastHitter); only text differs.
function sideLabel(side) {
  if (state.mode === '2p') return side === 'you' ? 'Player 1' : 'Player 2';
  return side === 'you' ? 'You' : 'AI';
}

const MODE_HINTS = {
  ai: 'One hand is your paddle — move it to swing.',
  2: 'Two hands, two paddles: P1 left half · P2 right half.',
};

function syncModeUi() {
  for (const btn of el['mode-seg'].querySelectorAll('button')) {
    const on = btn.dataset.mode === state.mode;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-checked', String(on));
  }
  el['difficulty-block'].classList.toggle('hidden', state.mode === '2p');
  if (el['mode-hint']) {
    el['mode-hint'].textContent = state.mode === '2p'
      ? 'Split screen — P1 plays from the near end (left view), P2 from the far end (right view).'
      : 'One hand is your paddle.';
  }
}

function setMode(mode) {
  if (mode !== 'ai' && mode !== '2p') return;
  state.mode = mode;
  syncModeUi();
  saveGame();
}

function refreshIntroStats() {
  el['stat-wins'].textContent = state.stats.wins;
  el['stat-losses'].textContent = state.stats.losses;
  el['stat-rally'].textContent = state.stats.bestRally;
}

function goToIntro() {
  state.paused = false;
  state.phase = 'idle';
  refreshIntroStats();
  syncSoundBtn();
  syncModeUi();
  showScreen('intro');
}

function goToSetup() {
  state.inputMode = 'hand';
  state.hand.everDetected = false;
  state.hand2.everDetected = false;
  el['btn-start-match'].disabled = true;
  el['btn-start-match'].textContent = twoPlayer() ? 'Waiting for both hands…' : 'Waiting for hand…';
  el['setup-progress'].classList.remove('hidden');
  setSetupStatus('Starting camera…');
  showScreen('setup');
  initCameraAndModel();
}

function twoPlayer() { return state.mode === '2p'; }

function setSetupStatus(msg) { el['setup-status'].textContent = msg; }

function setSetupProgress(frac) {
  el['setup-progress-bar'].style.width = Math.round(frac * 100) + '%';
}

function setupReadyCheck() {
  if (state.screen !== 'setup') return;
  if (state.cameraReady && state.modelReady) {
    setSetupProgress(1);
    el['setup-progress'].classList.add('hidden');
    setSetupStatus(twoPlayer() ? 'Camera ready — show both hands ✋✋' : 'Camera ready — show your hand ✋');
  }
  const ready = twoPlayer()
    ? (state.hand.everDetected && state.hand2.everDetected)
    : state.hand.everDetected;
  if (ready) {
    el['btn-start-match'].disabled = false;
    el['btn-start-match'].textContent = 'Start match';
  }
}

function showError(title, msg) {
  el['error-title'].textContent = title;
  el['error-msg'].textContent = msg;
  showScreen('error');
}

/* ============================================================
   7. CAMERA & TRACKING
   ============================================================ */

let video = null;
let visionModule = null;

async function initCameraAndModel() {
  state.cameraReady = false;
  state.modelReady = false;
  setSetupProgress(0.05);

  const camPromise = initCamera();
  const modelPromise = initHandModel();

  try {
    await camPromise;
    state.cameraReady = true;
    setSetupStatus(state.modelReady
      ? (twoPlayer() ? 'Camera ready — show both hands ✋✋' : 'Camera ready — show your hand ✋')
      : 'Loading hand-tracking model…');
    setupReadyCheck();
  } catch (err) {
    showError('Camera unavailable', cameraErrorMessage(err));
    return;
  }

  try {
    await modelPromise;
    state.modelReady = true;
    setupReadyCheck();
  } catch (err) {
    showError('Model failed to load',
      'The hand-tracking model could not be downloaded. Check your internet connection and try again.');
  }
}

function cameraErrorMessage(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Camera permission was denied. Allow camera access for this page and try again — or play with the keyboard.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera was found on this device. You can still play with the keyboard.';
  }
  if (name === 'NotReadableError') {
    return 'The camera is busy in another app. Close it and try again.';
  }
  return 'The camera could not be started (' + (name || 'unknown error') + '). You can still play with the keyboard.';
}

async function initCamera() {
  video = el.camera;
  if (TEST_MODE) {
    // Hermetic: no real camera in automated runs.
    video.width = 640; video.height = 480;
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

/* ---------- Tracking pipeline (lag fix) ----------
   Old: detectForVideo ran synchronously inside the rAF loop, so a slow
   CPU inference frame stalled rendering → the whole game felt laggy.
   New: the main thread only snapshots the video into an ImageBitmap
   (async, cheap) and transfers it to hand-worker.js, which owns the
   HandLandmarker. Results come back as messages and are consumed on
   the next animation frame — inference can never block the render.
   If the worker path is unavailable, we fall back to the old
   synchronous main-thread landmarker. */

let trackingWorker = null;
let workerReady = false;        // worker landmarker initialized
let workerDead = false;         // worker failed permanently → use sync fallback
let bitmapInFlight = false;     // one frame snapshot in flight at a time
let syncLandmarker = null;      // fallback: main-thread landmarker
let syncLandmarkerPromise = null;
let lastVideoTime = -1;
let trackTs = 0;
let latestTracking = null;      // newest worker result, consumed each rAF

function initWorkerTracking() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ok ? resolve() : reject(err || new Error('worker init failed'));
    };
    // Generous: first run downloads the wasm + model from the CDN.
    const timeout = setTimeout(() => finish(false, new Error('hand-tracking worker timed out')), 25000);

    try {
      trackingWorker = new Worker('hand-worker.js', { type: 'module' });
    } catch (err) {
      finish(false, err);
      return;
    }

    trackingWorker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'ready') {
        workerReady = true;
        setSetupProgress(0.9);
        setupReadyCheck();
        finish(true);
      } else if (m.type === 'error') {
        finish(false, new Error(m.message || 'worker error'));
      } else if (m.type === 'result') {
        bitmapInFlight = false;
        latestTracking = m;
      }
    };
    trackingWorker.onerror = () => {
      workerDead = true;
      workerReady = false;
      finish(false, new Error('worker crashed'));
    };

    trackingWorker.postMessage({ type: 'init' });
  });
}

async function initHandModel() {
  if (TEST_MODE) return;

  // Preferred path: off-thread inference.
  try {
    setSetupProgress(0.15);
    await initWorkerTracking();
    return;
  } catch { /* fall through to the synchronous path */ }
  if (trackingWorker) { try { trackingWorker.terminate(); } catch { /* ignore */ } trackingWorker = null; }

  // Fallback: original main-thread landmarker (blocks per frame, but works).
  setSetupProgress(0.3);
  visionModule = await import(/* @vite-ignore */ MP_BUNDLE);
  setSetupProgress(0.55);
  const fileset = await visionModule.FilesetResolver.forVisionTasks(MP_WASM);
  setSetupProgress(0.75);
  syncLandmarker = await createSyncLandmarker(fileset);
  setSetupProgress(0.9);
}

async function createSyncLandmarker(fileset) {
  const make = (delegate) => visionModule.HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MP_MODEL, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    return await make('GPU');
  } catch {
    return await make('CPU');   // GPU unsupported (some iOS) → CPU
  }
}

// Lazily build a sync landmarker if the worker dies after succeeding.
function ensureSyncLandmarker() {
  if (syncLandmarker) return Promise.resolve(syncLandmarker);
  if (!syncLandmarkerPromise) {
    syncLandmarkerPromise = (async () => {
      if (!visionModule) visionModule = await import(/* @vite-ignore */ MP_BUNDLE);
      const fileset = await visionModule.FilesetResolver.forVisionTasks(MP_WASM);
      syncLandmarker = await createSyncLandmarker(fileset);
      return syncLandmarker;
    })().catch(() => { syncLandmarkerPromise = null; return null; });
  }
  return syncLandmarkerPromise;
}

// Called once per animation frame: feed the tracker + consume results.
function pumpTracking(nowMs) {
  if (TEST_MODE) { applyFakeHands(); return; }

  // Consume the newest worker result (never blocks — it's already done).
  if (latestTracking) {
    applyTracking(latestTracking.hands || [], nowMs);
    latestTracking = null;
  }

  if (!video || video.readyState < 2 || !video.videoWidth) return;
  if (video.currentTime === lastVideoTime) return;   // no new camera frame yet
  lastVideoTime = video.currentTime;

  if (workerReady && !bitmapInFlight && typeof createImageBitmap === 'function') {
    bitmapInFlight = true;
    createImageBitmap(video).then((bmp) => {
      trackTs = Math.max(trackTs + 1, Math.floor(performance.now()));
      trackingWorker.postMessage({ type: 'frame', bitmap: bmp, ts: trackTs }, [bmp]);
    }).catch(() => { bitmapInFlight = false; });
    return;
  }

  // Worker unavailable → synchronous main-thread inference (fallback).
  if (!workerReady) {
    if (syncLandmarker) {
      runSyncDetection(nowMs);
    } else if (workerDead) {
      ensureSyncLandmarker().then((lm) => { if (lm) runSyncDetection(nowMs); });
    }
  }
}

function runSyncDetection(nowMs) {
  let result = null;
  try {
    trackTs = Math.max(trackTs + 1, Math.floor(performance.now()));
    result = syncLandmarker.detectForVideo(video, trackTs);
  } catch { return; }
  const hands = [];
  const lms = (result && result.landmarks) || [];
  for (const lm of lms) hands.push(lm);
  applyTracking(hands, nowMs);
}

// Test seam: pretend N hands are at fixed mirrored positions.
function applyFakeHands() {
  const slots = [state.hand, state.hand2];
  const list = state.fakeHands;
  for (let i = 0; i < slots.length; i++) {
    const f = list && list[i];
    if (f) {
      const s = slots[i];
      s.rawX = f.x; s.rawY = f.y;
      s.detected = true;
      s.lostMs = 0;
      if (!s.everDetected) s.everDetected = true;
      setupReadyCheck();
    } else {
      slots[i].detected = false;
    }
  }
}

// Distribute detected hands between player slots.
//
// Two-player rule: hands belong to whichever slot they were closest to
// recently (greedy nearest-neighbor), so players can move freely without
// their paddles swapping. Fresh sessions seed by position: leftmost hand
// (in mirrored view) → P1, rightmost → P2.
function applyTracking(hands, nowMs) {
  // Build palm centroids (mirrored normalized coords).
  const palms = [];
  for (const lm of hands) {
    if (!lm || lm.length < 21) continue;
    let sx = 0, sy = 0;
    for (const i of PALM_IDX) { sx += lm[i].x; sy += lm[i].y; }
    sx /= PALM_IDX.length; sy /= PALM_IDX.length;
    palms.push({ mx: 1 - sx, my: sy, lm });       // mirror x like the preview
    if (palms.length >= 2) break;                  // two slots is all we need
  }

  const slots = [state.hand, state.hand2];
  const usedHand = [false, false];

  if (!twoPlayer()) {
    // Single player: keep whichever hand is nearest P1's previous spot.
    const s = slots[0];
    let best = -1, bestD = Infinity;
    for (let i = 0; i < palms.length; i++) {
      const d = Math.hypot(palms[i].mx - s.assignX, palms[i].my - s.assignY);
      if (d < bestD) { bestD = d; best = i; }
    }
    assignPalm(s, best >= 0 ? palms[best] : null, nowMs);
    slots[1].detected = false;
    slots[1].landmarks = null;   // no ghost P2 skeleton in the PiP
    return;
  }

  // Greedy match palms to recently-seen slots.
  const pairs = [];
  for (let si = 0; si < slots.length; si++) {
    if (nowMs - slots[si].lastSeenMs > ASSIGN_MEMORY_MS) continue;
    for (let pi = 0; pi < palms.length; pi++) {
      if (usedHand[pi]) continue;
      const d = Math.hypot(palms[pi].mx - slots[si].assignX, palms[pi].my - slots[si].assignY);
      pairs.push({ d, si, pi });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const slotTaken = [false, false];
  for (const pr of pairs) {
    if (slotTaken[pr.si] || usedHand[pr.pi]) continue;
    slotTaken[pr.si] = true; usedHand[pr.pi] = true;
    assignPalm(slots[pr.si], palms[pr.pi], nowMs);
  }

  // Remaining palms fill empty slots by position (leftmost → P1).
  const freeSlots = [];
  for (let si = 0; si < slots.length; si++) if (!slotTaken[si]) freeSlots.push(si);
  const freePalms = [];
  for (let pi = 0; pi < palms.length; pi++) if (!usedHand[pi]) freePalms.push(pi);
  freePalms.sort((a, b) => palms[a].mx - palms[b].mx);
  for (let k = 0; k < freePalms.length && k < freeSlots.length; k++) {
    assignPalm(slots[freeSlots[k]], palms[freePalms[k]], nowMs);
  }
  for (const si of freeSlots.slice(freePalms.length)) {
    slots[si].detected = false;
    slots[si].landmarks = null;
  }

  if (palms.length === 0) {
    for (const s of slots) { s.detected = false; s.landmarks = null; }
  }
}

function assignPalm(slot, palm, nowMs) {
  if (!palm) {
    slot.detected = false;
    slot.landmarks = null;      // don't leave a ghost skeleton in the PiP
    return;
  }
  slot.rawX = palm.mx;
  slot.rawY = palm.my;
  slot.assignX = palm.mx;
  slot.assignY = palm.my;
  slot.lastSeenMs = nowMs;
  slot.detected = true;
  slot.lostMs = 0;
  slot.landmarks = palm.lm;
  if (!slot.everDetected) slot.everDetected = true;
  setupReadyCheck();
}

/* ============================================================
   8. HAND INPUT → 3D PADDLES
   ============================================================ */

function updateHandInput(dt) {
  updateHandSlot(state.hand, 0, dt);
  if (twoPlayer()) updateHandSlot(state.hand2, 1, dt);
}

function updateHandSlot(hand, idx, dt) {
  const pl = idx === 0 ? state.player : state.p2;

  if (hand.detected) {
    hand.lostMs = 0;

    // Speed-adaptive exponential smoothing (framerate independent):
    // a slow hand is filtered hard (steady aim); a fast swing barely at
    // all, so the paddle keeps up instead of lagging a beat behind.
    const rawSpeed = dt > 0
      ? Math.hypot(hand.rawX - hand.prevRawX, hand.rawY - hand.prevRawY) / dt
      : 0;
    hand.motion += (rawSpeed - hand.motion) * Math.min(1, dt * 14);
    hand.prevRawX = hand.rawX;
    hand.prevRawY = hand.rawY;
    const rate = SMOOTH_SLOW + (SMOOTH_FAST - SMOOTH_SLOW) *
      clampNum(hand.motion / ADAPT_REF_SPEED, 0, 1);
    const a = 1 - Math.exp(-dt * rate);
    hand.smX += (hand.rawX - hand.smX) * a;
    hand.smY += (hand.rawY - hand.smY) * a;

    // Map normalized hand position into the paddle workspace. P2 plays
    // from the far rail watching a 180°-rotated view, so their x axis is
    // flipped: moving your hand to *your* right moves your paddle to
    // your right on screen.
    const nx = (hand.smX - HAND_X_MIN) / (HAND_X_MAX - HAND_X_MIN);
    const ny = (hand.smY - HAND_Y_MIN) / (HAND_Y_MAX - HAND_Y_MIN);
    const flip = idx === 1 ? -1 : 1;
    pl.targetX = flip * Math.min(1.12, Math.max(-1.12, nx * 2 - 1)) * PADDLE_X_RANGE;
    pl.targetY = PADDLE_Y_TOP - Math.min(1, Math.max(0, ny)) * (PADDLE_Y_TOP - PADDLE_Y_BOT);
  } else {
    hand.lostMs += dt * 1000;
    // Paddle coasts: targets stay where they were.
  }

  movePaddle(pl, idx === 0 ? pad1Keys : pad2Keys, dt);
}

function updateKeyboardInput(dt) {
  drivePaddleKeyboard(state.player, pad1Keys, dt);
  if (twoPlayer()) drivePaddleKeyboard(state.p2, pad2Keys, dt);
}

function drivePaddleKeyboard(p, keysPad, dt) {
  const dx = (keysPad.right ? 1 : 0) - (keysPad.left ? 1 : 0);
  const dy = (keysPad.down ? 1 : 0) - (keysPad.up ? 1 : 0);
  // P2's view is rotated 180°, so their left/right keys flip in world x.
  const flip = twoPlayer() && p === state.p2 ? -1 : 1;
  p.targetX = p.x + flip * dx * KEY_SPEED * dt;
  p.targetY = p.y - dy * KEY_SPEED * dt;
  movePaddle(p, keysPad, dt);
}

function movePaddle(p, keysPad, dt) {
  const tx = Math.min(PADDLE_X_RANGE, Math.max(-PADDLE_X_RANGE, p.targetX));
  const ty = Math.min(PADDLE_Y_TOP, Math.max(PADDLE_Y_BOT, p.targetY));

  const prevX = p.x, prevY = p.y;
  const a = 1 - Math.exp(-dt * 32);
  p.x += (tx - p.x) * a;
  p.y += (ty - p.y) * a;

  // Swing velocity (used for spin, power and serve detection).
  if (dt > 0) {
    const ivx = (p.x - prevX) / dt;
    const ivy = (p.y - prevY) / dt;
    p.vx += (ivx - p.vx) * Math.min(1, dt * 26);
    p.vy += (ivy - p.vy) * Math.min(1, dt * 26);
  }
  let kb = 0;
  if (keysPad && keysPad.swing > 0) { kb = 2.6; keysPad.swing = Math.max(0, keysPad.swing - dt * 6); }
  p.speed = Math.max(Math.hypot(p.vx, p.vy), kb);

  // Gentle lunge toward the net while swinging fast (visual only).
  const rail = p.railZ !== undefined ? p.railZ : PADDLE_Z;
  const lunge = Math.min(0.18, p.speed * 0.045);
  p.z = rail + (rail > 0 ? -lunge : lunge);
}

// Single place that shows/hides the "show your hand" nudge.
function updateHandHints() {
  let text = '';
  if (state.inputMode === 'hand') {
    const missing = [];
    if (state.hand.lostMs > HAND_LOST_MS) missing.push(twoPlayer() ? 'P1' : '');
    if (twoPlayer() && state.hand2.lostMs > HAND_LOST_MS) missing.push('P2');
    if (missing.length) {
      const names = missing.filter(Boolean).join(' & ');
      text = names
        ? `✋ ${names} — show your hand${missing.length > 1 ? 's' : ''} to the camera`
        : '✋ Show your hand to the camera';
    }
  }
  const show = text !== '' && state.screen === 'play' && !state.paused;
  el['hand-hint'].classList.toggle('hidden', !show);
  if (show) el['hand-hint'].textContent = text;
}

/* ============================================================
   9. 3D SCENE
   ============================================================ */

const world = {
  renderer: null, scene: null, camera: null, camera2: null,
  ball: null, ballShadow: null, trail: [],
  playerPaddle: null, p2Paddle: null, aiPaddle: null, opponent: null,
};

function initThree() {
  world.renderer = new THREE.WebGLRenderer({ canvas: el.game, antialias: true });
  world.renderer.shadowMap.enabled = true;
  world.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  world.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  world.renderer.toneMappingExposure = 1.12;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070b16);
  scene.fog = new THREE.Fog(0x070b16, 9, 22);
  world.scene = scene;

  world.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 60);
  world.camera.position.set(0, 1.72, 2.35);
  world.camera.lookAt(0, 0.78, -0.55);

  // Second POV for two-player split screen: from the far end of the
  // table looking back (rotated 180° around the table).
  world.camera2 = new THREE.PerspectiveCamera(58, 1, 0.1, 60);
  world.camera2.position.set(0, 1.72, PADDLE_Z_FAR - 1.2);
  world.camera2.lookAt(0, 0.78, 0.55);

  buildArena(scene);
  buildTable(scene);
  buildBall(scene);
  world.playerPaddle = buildPaddle(scene, 0xe23b4e, true);
  // Second near-rail paddle for two-player mode (hidden in single-player).
  world.p2Paddle = buildPaddle(scene, 0x35a0ff, true);
  world.p2Paddle.visible = false;
  world.aiPaddle = buildPaddle(scene, 0x1c1c22, false);
  buildOpponent(scene);
}

function buildArena(scene) {
  // Floor
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(11, 48),
    new THREE.MeshStandardMaterial({ color: 0x0b1020, roughness: 0.95, metalness: 0 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Subtle floor grid
  const grid = new THREE.GridHelper(22, 44, 0x1c2a4a, 0x111a30);
  grid.position.y = 0.005;
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  scene.add(grid);

  // Glow ring around the table
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.15, 2.32, 64),
    new THREE.MeshBasicMaterial({ color: 0x4dd7ff, transparent: true, opacity: 0.28, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.012;
  scene.add(ring);

  // Back wall + neon strips
  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 6),
    new THREE.MeshStandardMaterial({ color: 0x0d1426, roughness: 1 })
  );
  wall.position.set(0, 3, -7);
  scene.add(wall);

  const stripGeo = new THREE.BoxGeometry(9, 0.07, 0.05);
  const stripCyan = new THREE.Mesh(stripGeo, new THREE.MeshBasicMaterial({ color: 0x4dd7ff }));
  stripCyan.position.set(-4.5, 2.6, -6.95);
  scene.add(stripCyan);
  const stripPink = new THREE.Mesh(stripGeo, new THREE.MeshBasicMaterial({ color: 0xff5d73 }));
  stripPink.position.set(4.5, 2.2, -6.95);
  scene.add(stripPink);
  const stripGreen = new THREE.Mesh(new THREE.BoxGeometry(5, 0.05, 0.05), new THREE.MeshBasicMaterial({ color: 0x35e08c }));
  stripGreen.position.set(0, 3.6, -6.95);
  scene.add(stripGreen);

  // Mirror wall + strips behind P1's camera (they fill P2's split-screen
  // POV, which looks the opposite way up the arena).
  const wall2 = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 6),
    new THREE.MeshStandardMaterial({ color: 0x0d1426, roughness: 1 })
  );
  wall2.position.set(0, 3, 7);
  wall2.rotation.y = Math.PI;
  scene.add(wall2);
  const stripCyan2 = new THREE.Mesh(stripGeo, stripCyan.material);
  stripCyan2.position.set(4.5, 2.6, 6.95);
  scene.add(stripCyan2);
  const stripPink2 = new THREE.Mesh(stripGeo, stripPink.material);
  stripPink2.position.set(-4.5, 2.2, 6.95);
  scene.add(stripPink2);
  const stripGreen2 = new THREE.Mesh(stripGreen.geometry, stripGreen.material);
  stripGreen2.position.set(0, 3.6, 6.95);
  scene.add(stripGreen2);

  // Side barrier boards (like real TT surrounds)
  const boardMat = new THREE.MeshStandardMaterial({ color: 0x101a30, roughness: 0.9 });
  for (const side of [-1, 1]) {
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.55, 5.2), boardMat);
    board.position.set(side * 2.6, 0.275, 0);
    scene.add(board);
  }
  const farBoard = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.55, 0.04), boardMat);
  farBoard.position.set(0, 0.275, -3.1);
  scene.add(farBoard);

  // Lights
  scene.add(new THREE.HemisphereLight(0x8fb4ff, 0x1a1420, 0.85));

  const key = new THREE.DirectionalLight(0xfff2dd, 1.7);
  key.position.set(2.5, 5.5, 3.5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -3; key.shadow.camera.right = 3;
  key.shadow.camera.top = 3; key.shadow.camera.bottom = -3;
  key.shadow.camera.near = 1; key.shadow.camera.far = 12;
  scene.add(key);

  const cyan = new THREE.PointLight(0x4dd7ff, 18, 9);
  cyan.position.set(-3, 2.4, -2.5);
  scene.add(cyan);
  const pink = new THREE.PointLight(0xff5d73, 16, 9);
  pink.position.set(3, 2.4, 2.5);
  scene.add(pink);
}

function buildTable(scene) {
  const group = new THREE.Group();

  // Playing surface (top at TABLE.H)
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.W, 0.04, TABLE.L),
    new THREE.MeshStandardMaterial({ color: 0x1a4fa0, roughness: 0.35, metalness: 0.05 })
  );
  top.position.y = TABLE.H - 0.02;
  top.receiveShadow = true;
  group.add(top);

  // White boundary lines (edges of the surface)
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(TABLE.W, 0.001, TABLE.L)),
    new THREE.LineBasicMaterial({ color: 0xeef3ff })
  );
  edges.position.y = TABLE.H + 0.002;
  group.add(edges);

  // Center line (lengthwise)
  const centerLine = new THREE.Mesh(
    new THREE.BoxGeometry(0.012, 0.002, TABLE.L),
    new THREE.MeshBasicMaterial({ color: 0xeef3ff })
  );
  centerLine.position.y = TABLE.H + 0.002;
  group.add(centerLine);

  // Apron under the surface
  const apron = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.W - 0.08, 0.09, TABLE.L - 0.12),
    new THREE.MeshStandardMaterial({ color: 0x0e1526, roughness: 0.8 })
  );
  apron.position.y = TABLE.H - 0.085;
  group.add(apron);

  // Legs
  const legMat = new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.5, metalness: 0.6 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, TABLE.H - 0.06, 0.06), legMat);
    leg.position.set(sx * 0.62, (TABLE.H - 0.06) / 2, sz * 1.1);
    leg.castShadow = true;
    group.add(leg);
  }

  // Net assembly
  const net = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.NET_W, TABLE.NET_H - 0.012, 0.008),
    new THREE.MeshStandardMaterial({ color: 0x9aa7c0, transparent: true, opacity: 0.75, roughness: 0.9 })
  );
  net.position.set(0, TABLE.H + (TABLE.NET_H - 0.012) / 2, 0);
  group.add(net);

  const netTop = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.NET_W, 0.012, 0.01),
    new THREE.MeshBasicMaterial({ color: 0xeef3ff })
  );
  netTop.position.set(0, NET_TOP - 0.006, 0);
  group.add(netTop);

  const postMat = new THREE.MeshStandardMaterial({ color: 0x2a3040, roughness: 0.4, metalness: 0.7 });
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, TABLE.NET_H + 0.02, 10), postMat);
    post.position.set(sx * (TABLE.NET_W / 2), TABLE.H + TABLE.NET_H / 2, 0);
    group.add(post);
  }

  scene.add(group);
}

function buildBall(scene) {
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_R, 24, 16),
    new THREE.MeshStandardMaterial({
      color: 0xfff6e0, emissive: 0x775511, emissiveIntensity: 0.35, roughness: 0.4,
    })
  );
  ball.castShadow = true;
  scene.add(ball);
  world.ball = ball;

  // Soft shadow blob projected on the table/floor.
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.055, 20),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 })
  );
  shadow.rotation.x = -Math.PI / 2;
  scene.add(shadow);
  world.ballShadow = shadow;

  // Trail
  for (let i = 0; i < 10; i++) {
    const t = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R * (0.28 + i * 0.05), 10, 8),
      new THREE.MeshBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0.05 + i * 0.02 })
    );
    t.visible = false;
    scene.add(t);
    world.trail.push(t);
  }
}

function buildPaddle(scene, rubberColor, isPlayer) {
  const group = new THREE.Group();

  // Blade (axis along z so the flat faces point down-table)
  const blade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.105, 0.105, 0.014, 28),
    new THREE.MeshStandardMaterial({ color: 0xd8c9a8, roughness: 0.7 })
  );
  blade.rotation.x = Math.PI / 2;
  blade.castShadow = true;
  group.add(blade);

  // Rubber faces
  const rubberNear = new THREE.Mesh(
    new THREE.CircleGeometry(0.105, 28),
    new THREE.MeshStandardMaterial({ color: rubberColor, roughness: 0.85 })
  );
  rubberNear.position.z = 0.0085;
  group.add(rubberNear);
  const rubberFar = new THREE.Mesh(
    new THREE.CircleGeometry(0.105, 28),
    new THREE.MeshStandardMaterial({ color: isPlayer ? 0x1c1c22 : 0xe23b4e, roughness: 0.85 })
  );
  rubberFar.position.z = -0.0085;
  rubberFar.rotation.y = Math.PI;
  group.add(rubberFar);

  // Handle
  const handle = new THREE.Mesh(
    new THREE.BoxGeometry(0.034, 0.115, 0.022),
    new THREE.MeshStandardMaterial({ color: 0xc9a06a, roughness: 0.75 })
  );
  handle.position.y = -0.155;
  handle.castShadow = true;
  group.add(handle);

  scene.add(group);
  return group;
}

function buildOpponent(scene) {
  const group = new THREE.Group();

  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.17, 0.52, 6, 14),
    new THREE.MeshStandardMaterial({ color: 0x232a3f, roughness: 0.85 })
  );
  torso.position.y = 1.28;
  torso.castShadow = true;
  group.add(torso);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.11, 18, 14),
    new THREE.MeshStandardMaterial({ color: 0x2e3648, roughness: 0.8 })
  );
  head.position.y = 1.72;
  group.add(head);

  // Glowing visor so the opponent reads as "AI"
  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(0.14, 0.022, 0.02),
    new THREE.MeshBasicMaterial({ color: 0xff5d73 })
  );
  visor.position.set(0, 1.73, 0.1);
  group.add(visor);

  group.position.set(0, 0, -2.05);
  scene.add(group);
  world.opponent = group;
}

/* ============================================================
   10. MATCH FLOW
   ============================================================ */

function resetMatch() {
  state.scoreYou = 0;
  state.scoreAI = 0;
  state.rally = 0;
  state.longestRally = 0;
  state.serveSide = 'you';
  state.lastPointWinner = null;
  state.paused = false;
  state.phase = 'idle';      // clears any 'over' so overlays re-evaluate
  state.ai.aimErrX = 0;
  state.ai.aimErrZ = 0;
  state.ai.reactT = 0;
  state.ai.x = 0; state.ai.targetX = 0;
  state.ai.y = 1.0; state.ai.targetY = 1.0;
  // P1 on the near rail, P2 on the far rail (two-player).
  state.player.x = 0; state.player.targetX = 0;
  state.player.y = 1.1; state.player.targetY = 1.1;
  state.player.z = PADDLE_Z;
  state.player.vx = state.player.vy = 0; state.player.speed = 0;
  state.player.hitCooldown = 0;
  state.p2.x = 0; state.p2.targetX = 0;
  state.p2.y = 1.0; state.p2.targetY = 1.0;
  state.p2.z = PADDLE_Z_FAR;
  state.p2.vx = state.p2.vy = 0; state.p2.speed = 0;
  state.p2.hitCooldown = 0;
}

// The AI figure only exists in single-player mode.
function syncOpponentVisibility() {
  if (world.opponent) world.opponent.visible = !twoPlayer();
}

function startMatch() {
  resetMatch();
  syncOpponentVisibility();
  syncScoreLabels();
  showScreen('play');
  state.phase = 'countdown';
  state.timer = COUNTDOWN_STEP * 3;
  state.lastCountdown = -1;
}

function syncScoreLabels() {
  if (!el['score-label-you']) return;
  el['score-label-you'].textContent = twoPlayer() ? 'P1' : 'YOU';
  el['score-label-ai'].textContent = twoPlayer() ? 'P2' : 'AI';
}

function currentServer() {
  const total = state.scoreYou + state.scoreAI;
  if (state.scoreYou >= 10 && state.scoreAI >= 10) {
    return total % 2 === 0 ? 'you' : 'ai';      // deuce: alternate every point
  }
  const block = Math.floor(total / 2) % 2;      // blocks of 2, starting with player
  return block === 0 ? 'you' : 'ai';
}

// Banner text for whoever is about to serve.
function showServeBanner() {
  if (state.serveSide === 'you') {
    showBanner(twoPlayer() ? "Player 1's serve" : 'Your serve', 'Swipe through the ball to launch it');
  } else {
    showBanner(twoPlayer() ? "Player 2's serve" : 'AI serve',
      twoPlayer() ? 'Swipe through the ball to launch it' : 'Get ready…');
  }
}

function beginServe() {
  state.phase = 'serve';
  state.serveTimer = 0;
  state.rally = 0;
  state.serveSide = currentServer();
  const b = state.ball;
  b.vx = b.vy = b.vz = 0;
  b.lastHitter = null;
  b.bounces = 0;
  b.validOpponentBounce = false;
  b.visible = true;
  updateServeChip();
  showServeBanner();
}

// The paddle that is currently serving.
function serverPaddle() {
  if (state.serveSide === 'you') return state.player;
  return twoPlayer() ? state.p2 : state.ai;
}

// Unified serve launch for all three cases (P1 / P2 / AI).
function launchServe() {
  const b = state.ball;
  const sp = serverPaddle();
  const aiControlled = state.serveSide === 'ai' && !twoPlayer();
  const cfg = DIFFICULTY[state.difficulty];

  const power = aiControlled
    ? cfg.returnSpeed - 0.3
    : Math.min(3.5, 2.2 + sp.speed * 0.35);
  const aimX = aiControlled
    ? clampNum((Math.random() - 0.5) * 1.0, -0.62, 0.62)
    : clampNum(sp.vx * 0.14 + (Math.random() - 0.5) * 0.35, -0.62, 0.62);
  // Land on the receiver's half of the table (opposite side of the net).
  const dir = sp.z > 0 ? -1 : 1;
  const targetZ = dir * (0.5 + Math.random() * 0.7);

  const v = solveShot({ x: b.x, y: b.y, z: b.z }, { x: aimX, y: TABLE.H + BALL_R, z: targetZ }, power);
  b.vx = v.vx; b.vy = v.vy; b.vz = v.vz;
  b.lastHitter = state.serveSide;      // 'you' | 'ai'
  b.bounces = 0;
  b.validOpponentBounce = false;
  state.phase = 'rally';
  state.rally = 1;
  hideBanner();
  hitSound(power);
}

function scorePoint(winner) {
  if (state.phase !== 'rally') return;
  state.longestRally = Math.max(state.longestRally, state.rally);
  if (winner === 'you') state.scoreYou++; else state.scoreAI++;
  state.lastPointWinner = winner;
  state.phase = 'point';
  state.timer = POINT_TIME;

  if (winner === 'you') {
    showBanner(twoPlayer() ? 'Point Player 1!' : 'Your point!', `${state.scoreYou} : ${state.scoreAI}`, 'you');
    blip(660, 0.09, 'sine', 0.07);
    setTimeout(() => blip(880, 0.12, 'sine', 0.07), 90);
  } else {
    showBanner(twoPlayer() ? 'Point Player 2!' : 'AI point', `${state.scoreYou} : ${state.scoreAI}`, 'ai');
    blip(330, 0.1, 'sine', 0.06);
    setTimeout(() => blip(247, 0.14, 'sine', 0.06), 100);
  }
  if (navigator.vibrate) { try { navigator.vibrate(30); } catch { /* ignore */ } }
}

function afterPoint() {
  const you = state.scoreYou, ai = state.scoreAI;
  const lead = Math.abs(you - ai);
  const won = (you >= WIN_SCORE || ai >= WIN_SCORE) && lead >= WIN_BY;
  const capped = you >= SCORE_CAP || ai >= SCORE_CAP;
  if (won || capped) { endMatch(you > ai ? 'you' : 'ai'); return; }
  beginServe();
}

function endMatch(winner) {
  state.phase = 'over';
  state.longestRally = Math.max(state.longestRally, state.rally);
  if (state.longestRally > state.stats.bestRally) {
    state.stats.bestRally = state.longestRally;
    saveGame();
  }
  // Wins/losses are a "you vs AI" record — two-player matches don't touch them.
  if (!twoPlayer()) {
    if (winner === 'you') state.stats.wins++; else state.stats.losses++;
    saveGame();
  }

  const you = state.scoreYou, ai = state.scoreAI;
  el['gameover-emoji'].textContent = (winner === 'you' || twoPlayer()) ? '🏆' : '🤖';
  el['gameover-title'].textContent = twoPlayer()
    ? `${sideLabel(winner)} wins!`
    : (winner === 'you' ? 'You win!' : 'AI wins');
  el['gameover-title'].className = winner === 'you' ? 'win' : 'lose';
  el['gameover-score'].textContent = `${you} : ${ai}`;
  el['gameover-rally'].textContent = state.longestRally;
  el['gameover-diff'].textContent = twoPlayer() ? '2 Players' : DIFFICULTY[state.difficulty].label;
  hideBanner();
  showScreen('play');   // reveals the game-over overlay

  // Both players are human in 2p — always celebrate.
  const celebrate = winner === 'you' || twoPlayer();
  if (celebrate) {
    spawnConfetti();
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => blip(f, 0.16, 'triangle', 0.07), i * 130));
  } else {
    [392, 330, 262].forEach((f, i) => setTimeout(() => blip(f, 0.18, 'sine', 0.06), i * 160));
  }
}

function updateServeChip() {
  el['serve-chip'].textContent = state.serveSide === 'you'
    ? (twoPlayer() ? 'P1 serve' : 'Your serve')
    : (twoPlayer() ? 'P2 serve' : 'AI serve');
}

function clampNum(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/* ============================================================
   11. SHOT SOLVER — ballistic aim with net clearance
   ============================================================ */

// Returns the initial velocity that lands the ball at `to`, given launch speed.
// y(t) = y0 + vy·t − ½·G·t²  →  vy = (dy + ½·G·T²) / T
function solveShot(from, to, speed) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const dist = Math.hypot(dx, dz);
  let T = clampNum(dist / speed, 0.42, 1.7);

  let vx = 0, vy = 0, vz = 0;
  for (let i = 0; i < 4; i++) {
    vx = dx / T; vz = dz / T;
    vy = (dy + 0.5 * GRAVITY * T * T) / T;
    // Check net clearance: height where the trajectory crosses z = 0.
    if (Math.abs(vz) > 0.001) {
      const tNet = (0 - from.z) / vz;
      if (tNet > 0 && tNet < T) {
        const yNet = from.y + vy * tNet - 0.5 * GRAVITY * tNet * tNet;
        if (yNet < NET_TOP + 0.045) { T *= 1.3; continue; }   // lob higher
      }
    }
    break;
  }
  return { vx, vy, vz };
}

/* ============================================================
   12. BALL PHYSICS
   ============================================================ */

function stepBall(dt, scoring) {
  const b = state.ball;
  if (!b.visible) return;

  const speed = Math.hypot(b.vx, b.vy, b.vz);
  const steps = Math.max(1, Math.ceil(speed * dt / (BALL_R * 0.8)));
  const sdt = dt / steps;

  for (let i = 0; i < steps; i++) {
    const prevZ = b.z;

    b.vy -= GRAVITY * sdt;
    b.x += b.vx * sdt;
    b.y += b.vy * sdt;
    b.z += b.vz * sdt;

    // --- Net collision (crossing z=0 below net top, within net width) ---
    if (Math.sign(prevZ) !== Math.sign(b.z) && Math.abs(b.x) < TABLE.NET_W / 2) {
      const tCross = Math.abs(prevZ) / (Math.abs(prevZ) + Math.abs(b.z) || 1);
      const yCross = b.y - b.vy * sdt * (1 - tCross);
      if (yCross < NET_TOP && yCross > TABLE.H - 0.05) {
        // Hit the net: dribble back toward the side it came from.
        b.z = Math.sign(prevZ) * 0.02;
        b.vz = -b.vz * 0.16;
        b.vy *= 0.55;
        b.vx *= 0.7;
        blip(110, 0.08, 'sawtooth', 0.04);
      }
    }

    // --- Table bounce ---
    if (b.vy < 0 && b.y <= TABLE.H + BALL_R && b.y > TABLE.H - 0.12 &&
        Math.abs(b.x) <= HALF_W && Math.abs(b.z) <= HALF_L) {
      b.y = TABLE.H + BALL_R;
      b.vy = -b.vy * RESTITUTION;
      b.vx *= 0.96;
      b.vz *= 0.96;
      blip(175, 0.045, 'sine', 0.055);

      if (scoring && b.lastHitter) {
        const side = b.z > 0 ? 'near' : 'far';
        const ownSide = (b.lastHitter === 'you' && side === 'near') || (b.lastHitter === 'ai' && side === 'far');
        if (ownSide && b.bounces === 0 && !b.validOpponentBounce) {
          // Never crossed the net — fault.
          scorePoint(b.lastHitter === 'you' ? 'ai' : 'you');
          return;
        }
        b.bounces++;
        if (b.bounces === 1 && !ownSide) b.validOpponentBounce = true;
        if (b.bounces >= 2) {
          // Receiver failed to return it.
          scorePoint(b.lastHitter);
          return;
        }
      }
    }

    // --- Floor ---
    if (b.y < BALL_R) {
      b.y = BALL_R;
      if (Math.abs(b.vy) > 0.4) {
        b.vy = -b.vy * FLOOR_RESTITUTION;
        b.vx *= 0.8; b.vz *= 0.8;
        blip(120, 0.04, 'sine', 0.03);
      } else {
        b.vy = 0; b.vx *= 0.9; b.vz *= 0.9;
      }
      if (scoring && b.lastHitter) {
        // Touched the floor: resolve the point.
        scorePoint(b.validOpponentBounce ? b.lastHitter : (b.lastHitter === 'you' ? 'ai' : 'you'));
        return;
      }
    }

    // --- Out of the arena ---
    if (Math.abs(b.z) > 3.4 || Math.abs(b.x) > 3.0) {
      if (scoring && b.lastHitter) {
        scorePoint(b.validOpponentBounce ? b.lastHitter : (b.lastHitter === 'you' ? 'ai' : 'you'));
        return;
      }
      b.visible = false;
      return;
    }
  }
}

/* ============================================================
   13. PLAYER HITTING
   ============================================================ */

// The human-controlled paddles: P1 always; P2 joins in two-player,
// playing from the FAR rail (opposite ends, like real table tennis).
function nearSidePaddles() {
  return twoPlayer() ? [state.player, state.p2] : [state.player];
}

function stepPlayerHit(dt) {
  const b = state.ball;
  if (state.phase !== 'rally' || !b.visible) return;

  for (const pl of nearSidePaddles()) {
    pl.hitCooldown = Math.max(0, pl.hitCooldown - dt);
  }

  for (const pl of nearSidePaddles()) {
    if (b.lastHitter === pl.id || pl.hitCooldown > 0) continue;
    // The ball must be on this paddle's side of the net
    // (P1 defends z > 0, P2 defends z < 0).
    if (pl.z > 0 ? b.z < 0.22 : b.z > -0.22) continue;
    const dist = Math.hypot(b.x - pl.x, b.y - pl.y, b.z - pl.z);
    if (dist > PADDLE_REACH) continue;
    playerReturn(pl);
    break;                                             // one contact per step
  }
}

function playerReturn(pl) {
  const b = state.ball;

  // Contact! Aim the return using swing direction + a little randomness.
  const swing = Math.min(4, pl.speed);
  const speed = clampNum(2.3 + state.rally * 0.08 + swing * 0.45, 2.3, 6.2);
  const aimX = clampNum(pl.vx * 0.16 + (Math.random() - 0.5) * 0.3, -0.68, 0.68);
  // Aim at the opponent's half: P1 shoots toward −z, P2 toward +z.
  const dir = pl.z > 0 ? -1 : 1;
  const aimZ = dir * (0.45 + Math.random() * 0.8);
  const v = solveShot({ x: b.x, y: b.y, z: b.z }, { x: aimX, y: TABLE.H + BALL_R, z: aimZ }, speed);
  b.vx = v.vx; b.vy = v.vy; b.vz = v.vz;
  b.lastHitter = pl.id;
  b.bounces = 0;
  b.validOpponentBounce = false;
  state.rally++;
  pl.hitCooldown = 0.3;
  if (!twoPlayer()) {
    // Only the bot needs a reaction delay + fresh aim error.
    state.ai.reactT = DIFFICULTY[state.difficulty].react;
    state.ai.aimErrX = 0; state.ai.aimErrZ = 0;
  }
  hitSound(speed);
  if (navigator.vibrate) { try { navigator.vibrate(12); } catch { /* ignore */ } }
}

function hitSound(speed) {
  blip(300 + speed * 70, 0.05, 'square', 0.055);
}

/* ============================================================
   14. AI OPPONENT
   ============================================================ */

function stepAI(dt) {
  if (twoPlayer()) return;               // no bot on the far side in 2-player
  const cfg = DIFFICULTY[state.difficulty];
  const ai = state.ai;
  const b = state.ball;

  ai.hitCooldown = Math.max(0, ai.hitCooldown - dt);
  ai.reactT = Math.max(0, ai.reactT - dt);

  const incoming = state.phase === 'rally' && b.lastHitter === 'you' && b.vz < 0 && b.visible;

  if (incoming && ai.reactT <= 0) {
    // Predict where the ball arrives at the AI's rail (z = -1.15).
    const tArr = (b.z - ai.z) / -b.vz;
    if (tArr > 0 && tArr < 2.2) {
      let predX = b.x + b.vx * tArr;
      let predY = b.y + b.vy * tArr - 0.5 * GRAVITY * tArr * tArr;
      // If it arrives below the table, aim for the post-bounce rise instead.
      if (predY < TABLE.H + 0.05) predY = TABLE.H + 0.12;
      ai.targetX = clampNum(predX, -PADDLE_X_RANGE, PADDLE_X_RANGE);
      ai.targetY = clampNum(predY, 0.86, 1.5);
    } else {
      ai.targetX = 0; ai.targetY = 1.0;
    }
  } else if (!incoming) {
    // Drift toward center, shading toward the ball's x.
    ai.targetX = clampNum(b.x * 0.2, -0.5, 0.5);
    ai.targetY = 1.0;
  }

  // Move at capped speed.
  const dx = ai.targetX - ai.x;
  const dy = ai.targetY - ai.y;
  const dLen = Math.hypot(dx, dy);
  if (dLen > 0.001) {
    const step = Math.min(dLen, cfg.speed * dt);
    const prevX = ai.x;
    ai.x += dx / dLen * step;
    ai.y += dy / dLen * step;
    ai.vx = dt > 0 ? (ai.x - prevX) / dt : 0;
  }

  // Attempt a return.
  if (incoming && ai.hitCooldown <= 0 && b.z < -0.28) {
    const dist = Math.hypot(b.x - ai.x, b.y - ai.y, b.z - ai.z);
    if (dist <= PADDLE_REACH + 0.04) {
      aiReturn();
    }
  }
}

function aiReturn() {
  const cfg = DIFFICULTY[state.difficulty];
  const ai = state.ai;
  const b = state.ball;

  // Pick a target on the player's half; Hard aims away from the player.
  let aimX = (Math.random() - 0.5) * 1.1;
  if (cfg.aimAway) aimX = state.player.x < 0 ? 0.5 : -0.5;
  // Per-shot aim error (can push the shot wide/long → your point).
  if (ai.aimErrX === 0 && ai.aimErrZ === 0) {
    ai.aimErrX = (Math.random() * 2 - 1) * cfg.error;
    ai.aimErrZ = (Math.random() * 2 - 1) * cfg.error * 0.8;
  }
  const target = {
    x: clampNum(aimX + ai.aimErrX, -1.05, 1.05),
    y: TABLE.H + BALL_R,
    z: clampNum(0.5 + Math.random() * 0.72 + ai.aimErrZ, 0.25, 1.6),
  };

  const speed = clampNum(cfg.returnSpeed + state.rally * 0.06 + Math.random() * 0.4, 2.0, 5.6);
  const v = solveShot({ x: b.x, y: b.y, z: b.z }, target, speed);
  b.vx = v.vx; b.vy = v.vy; b.vz = v.vz;
  b.lastHitter = 'ai';
  b.bounces = 0;
  b.validOpponentBounce = false;
  state.rally++;
  ai.hitCooldown = 0.3;
  hitSound(speed);
}

/* ============================================================
   15. RENDERING — Three.js pass, PiP preview, HUD sync
   ============================================================ */

let previewCtx = null;
let confettiCtx = null;
const trailPts = [];

function renderScene(dt) {
  const p = state.player;
  const b = state.ball;

  // Player paddles follow the smoothed targets; tilt with the swing.
  const pp = world.playerPaddle;
  pp.position.set(p.x, p.y, p.z);
  pp.rotation.z = clampNum(-p.vx * 0.05, -0.5, 0.5);
  pp.rotation.x = 0.12 + clampNum(p.vy * 0.04, -0.35, 0.35);

  if (world.p2Paddle) {
    world.p2Paddle.visible = twoPlayer();
    if (twoPlayer()) {
      const q = state.p2;
      world.p2Paddle.position.set(q.x, q.y, q.z);
      world.p2Paddle.rotation.z = clampNum(-q.vx * 0.05, -0.5, 0.5);
      world.p2Paddle.rotation.x = 0.12 + clampNum(q.vy * 0.04, -0.35, 0.35);
    }
  }

  // AI paddle (single-player only).
  const ap = world.aiPaddle;
  ap.visible = !twoPlayer();
  if (!twoPlayer()) {
    ap.position.set(state.ai.x, state.ai.y, state.ai.z);
    ap.rotation.z = clampNum(state.ai.vx * 0.04, -0.4, 0.4);
  }

  // Opponent leans toward the ball.
  if (world.opponent && world.opponent.visible) {
    world.opponent.position.x += (clampNum(b.x * 0.3, -0.7, 0.7) - world.opponent.position.x) * Math.min(1, dt * 4);
    world.opponent.position.y = Math.sin(performance.now() * 0.0016) * 0.02;
  }

  // Ball + shadow + trail.
  world.ball.visible = b.visible;
  world.ball.position.set(b.x, b.y, b.z);
  world.ball.rotation.x += dt * 6;

  const overTable = Math.abs(b.x) <= HALF_W + 0.2 && Math.abs(b.z) <= HALF_L + 0.2 && b.y > TABLE.H;
  const shadowY = overTable ? TABLE.H + 0.004 : 0.006;
  const h = Math.max(0.05, b.y - shadowY);
  world.ballShadow.visible = b.visible;
  world.ballShadow.position.set(b.x, shadowY, b.z);
  const sScale = clampNum(1.6 - h * 0.55, 0.4, 1.6);
  world.ballShadow.scale.set(sScale, sScale, sScale);
  world.ballShadow.material.opacity = clampNum(0.42 - h * 0.16, 0.06, 0.42);

  if (b.visible && state.phase === 'rally') {
    trailPts.push({ x: b.x, y: b.y, z: b.z });
    if (trailPts.length > 10) trailPts.shift();
  } else if (trailPts.length) {
    trailPts.length = 0;
  }
  for (let i = 0; i < world.trail.length; i++) {
    const t = world.trail[i];
    const pt = trailPts[trailPts.length - 1 - i];
    if (pt) { t.visible = true; t.position.set(pt.x, pt.y, pt.z); }
    else t.visible = false;
  }

  // Camera sway follows each player's own paddle, then draw.
  // Two-player: split screen — left half is P1's POV from the near end,
  // right half is P2's POV from the far end (180° around the table).
  const r = world.renderer;
  if (twoPlayer() && world.camera2) {
    world.camera.position.x += (p.x * 0.09 - world.camera.position.x) * Math.min(1, dt * 5);
    world.camera.lookAt(0, 0.78, -0.55);
    world.camera2.position.x += (state.p2.x * 0.09 - world.camera2.position.x) * Math.min(1, dt * 5);
    world.camera2.lookAt(0, 0.78, 0.55);

    const hw = Math.floor(view.w / 2);
    const aspect = hw / view.h;
    if (world.camera.aspect !== aspect) { world.camera.aspect = aspect; world.camera.updateProjectionMatrix(); }
    if (world.camera2.aspect !== aspect) { world.camera2.aspect = aspect; world.camera2.updateProjectionMatrix(); }

    r.setScissorTest(true);
    r.setViewport(0, 0, hw, view.h);
    r.setScissor(0, 0, hw, view.h);
    r.render(world.scene, world.camera);
    r.setViewport(hw, 0, view.w - hw, view.h);
    r.setScissor(hw, 0, view.w - hw, view.h);
    r.render(world.scene, world.camera2);
    r.setScissorTest(false);
  } else {
    const aspect = view.w / view.h;
    if (world.camera.aspect !== aspect) { world.camera.aspect = aspect; world.camera.updateProjectionMatrix(); }
    world.camera.position.x += (p.x * 0.09 - world.camera.position.x) * Math.min(1, dt * 5);
    world.camera.lookAt(0, 0.78, -0.55);
    r.setViewport(0, 0, view.w, view.h);
    r.render(world.scene, world.camera);
  }
}

// Picture-in-picture camera preview with hand skeletons.
// Redrawn at most ~30fps — the 3D view is the star; the PiP is a mirror.
let lastPreviewDraw = 0;

function drawPreview() {
  const nowMs = performance.now();
  if (nowMs - lastPreviewDraw < PREVIEW_INTERVAL_MS) return;
  lastPreviewDraw = nowMs;

  const pc = previewCtx;
  const W = el.preview.width, H = el.preview.height;
  pc.fillStyle = '#05070d';
  pc.fillRect(0, 0, W, H);

  const feed = TEST_MODE ? state.fakeBackground : null;
  const liveVideo = !TEST_MODE && video && video.readyState >= 2 && video.videoWidth ? video : null;

  // Two-player: the preview splits down the middle — left half is P1's
  // region of the (mirrored) feed, right half is P2's.
  const split = twoPlayer();

  if (feed || liveVideo) {
    const src = feed || liveVideo;
    const sw = feed ? feed.width : liveVideo.videoWidth;
    const sh = feed ? feed.height : liveVideo.videoHeight;
    const s = Math.max(W / sw, H / sh);

    const drawFeed = (cx0, cw) => {
      pc.save();
      pc.beginPath();
      pc.rect(cx0, 0, cw, H);
      pc.clip();
      pc.translate(W, 0);
      pc.scale(-1, 1);                       // mirrored, like a mirror
      pc.drawImage(src, (W - sw * s) / 2, (H - sh * s) / 2, sw * s, sh * s);
      pc.restore();
    };
    if (split) { drawFeed(0, W / 2); drawFeed(W / 2, W - W / 2); }
    else drawFeed(0, W);

    // Skeletons — in split mode each half shows only its own player.
    const halves = split
      ? [[state.hand, 0, W / 2], [state.hand2, W / 2, W - W / 2]]
      : [[state.hand, 0, W], [state.hand2, 0, W]];
    for (const [slot, cx0, cw] of halves) {
      const lm = slot.landmarks;
      if (!lm) continue;
      const color = slot === state.hand2 ? 'rgba(255, 141, 77, 0.9)' : 'rgba(77, 215, 255, 0.85)';
      pc.save();
      pc.beginPath();
      pc.rect(cx0, 0, cw, H);
      pc.clip();
      pc.strokeStyle = color;
      pc.lineWidth = 2;
      pc.lineCap = 'round';
      for (const [a, bIdx] of HAND_CONNECTIONS) {
        pc.beginPath();
        pc.moveTo((1 - lm[a].x) * W, lm[a].y * H);
        pc.lineTo((1 - lm[bIdx].x) * W, lm[bIdx].y * H);
        pc.stroke();
      }
      pc.fillStyle = color;
      for (const pt of lm) {
        pc.beginPath();
        pc.arc((1 - pt.x) * W, pt.y * H, 3, 0, Math.PI * 2);
        pc.fill();
      }
      pc.restore();
    }

    if (split) {
      // Divider between the two players' regions + name tags.
      pc.fillStyle = 'rgba(238, 243, 255, 0.3)';
      pc.fillRect(W / 2 - 1, 0, 2, H);
      pc.font = '700 12px Inter, sans-serif';
      pc.textAlign = 'left';
      pc.fillStyle = 'rgba(53, 224, 140, 0.95)';
      pc.fillText('P1', 8, 17);
      pc.textAlign = 'right';
      pc.fillStyle = 'rgba(255, 141, 77, 0.95)';
      pc.fillText('P2', W - 8, 17);
    }
  } else {
    pc.fillStyle = '#9fb0d0';
    pc.font = '600 13px Inter, sans-serif';
    pc.textAlign = 'center';
    pc.fillText('camera warming up…', W / 2, H / 2);
  }
}

// HUD sync — cheap, only writes when values changed.
const hudCache = {};

function syncHud() {
  setHud('score-you', String(state.scoreYou));
  setHud('score-ai', String(state.scoreAI));
  setHud('rally-count', String(state.rally));
}

function setHud(id, text) {
  if (hudCache[id] !== text) {
    hudCache[id] = text;
    el[id].textContent = text;
  }
}

/* ============================================================
   16. BANNER / TOAST
   ============================================================ */

let bannerTimeout = null;

function showBanner(text, sub, tone) {
  el['banner-text'].textContent = text;
  el['banner-sub'].textContent = sub || '';
  el['banner-text'].style.color =
    tone === 'you' ? 'var(--accent)' : tone === 'ai' ? 'var(--accent-2)' : 'var(--ink)';
  el.banner.classList.remove('hidden');
  el.banner.classList.remove('pop');
  void el.banner.offsetWidth;          // restart the pop animation
  el.banner.classList.add('pop');
}

function hideBanner() {
  el.banner.classList.add('hidden');
  if (bannerTimeout) { clearTimeout(bannerTimeout); bannerTimeout = null; }
}

let toastTimeout = null;

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.toast.classList.add('hidden'), 2200);
}

/* ============================================================
   17. SOUND — lazy WebAudio, never breaks gameplay
   ============================================================ */

let audioCtx = null;

function ensureAudio() {
  if (!state.sound) return null;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  } catch { return null; }
}

function blip(freq, dur = 0.06, type = 'sine', gain = 0.05) {
  try {
    const ac = ensureAudio();
    if (!ac) return;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
    o.connect(g);
    g.connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + dur + 0.02);
  } catch { /* sound must never break gameplay */ }
}

function syncSoundBtn() {
  el['btn-sound'].textContent = state.sound ? '🔊' : '🔇';
}

function toggleSound() {
  state.sound = !state.sound;
  syncSoundBtn();
  saveGame();
  if (state.sound) blip(660, 0.07, 'sine', 0.05);
  toast(state.sound ? 'Sound on' : 'Sound off');
}

/* ============================================================
   18. CONFETTI
   ============================================================ */

let confettiParts = [];
let confettiUntil = 0;

function spawnConfetti() {
  if (REDUCED_MOTION) return;
  const colors = ['#35e08c', '#4dd7ff', '#ffd166', '#ff5d73', '#eef3ff'];
  confettiParts = [];
  for (let i = 0; i < 150; i++) {
    confettiParts.push({
      x: view.w / 2 + (Math.random() - 0.5) * view.w * 0.5,
      y: view.h * 0.25 + (Math.random() - 0.5) * 60,
      vx: (Math.random() - 0.5) * 420,
      vy: -Math.random() * 380 - 60,
      w: 5 + Math.random() * 6,
      h: 8 + Math.random() * 8,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 10,
      color: colors[i % colors.length],
    });
  }
  confettiUntil = performance.now() + 2800;
}

function stepConfetti(dt) {
  const cc = confettiCtx;
  cc.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  cc.clearRect(0, 0, view.w, view.h);
  if (confettiParts.length === 0 || performance.now() > confettiUntil) {
    if (confettiParts.length) confettiParts = [];
    return;
  }
  for (const p of confettiParts) {
    p.vy += 900 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    cc.save();
    cc.translate(p.x, p.y);
    cc.rotate(p.rot);
    cc.fillStyle = p.color;
    cc.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    cc.restore();
  }
}

/* ============================================================
   19. WIRING
   ============================================================ */

function setDifficulty(diff) {
  if (!DIFFICULTY[diff]) return;
  state.difficulty = diff;
  for (const btn of el['difficulty-seg'].querySelectorAll('button')) {
    const on = btn.dataset.diff === diff;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-checked', String(on));
  }
  saveGame();
}

function togglePause(force) {
  if (state.screen !== 'play') return;
  if (state.phase === 'over') return;
  const next = typeof force === 'boolean' ? force : !state.paused;
  if (next === state.paused) return;
  state.paused = next;
  showScreen('play');
  if (state.paused) {
    hideBanner();
    blip(300, 0.06, 'sine', 0.04);
  } else {
    if (state.phase === 'serve') showServeBanner();
    blip(500, 0.06, 'sine', 0.04);
  }
}

function startKeyboardMode() {
  state.inputMode = 'keyboard';
  toast(twoPlayer()
    ? '2P keyboard — P1: WASD + Space · P2: Arrows + Enter'
    : 'Keyboard mode — arrows move, Space swings');
  startMatch();
}

function wireControls() {
  // Intro
  el['btn-start'].addEventListener('click', () => { ensureAudio(); goToSetup(); });
  for (const btn of el['mode-seg'].querySelectorAll('button')) {
    btn.addEventListener('click', () => { ensureAudio(); setMode(btn.dataset.mode); });
  }
  for (const btn of el['difficulty-seg'].querySelectorAll('button')) {
    btn.addEventListener('click', () => setDifficulty(btn.dataset.diff));
  }

  // Setup
  el['btn-start-match'].addEventListener('click', () => { ensureAudio(); startMatch(); });
  el['btn-keyboard-mode'].addEventListener('click', () => { ensureAudio(); startKeyboardMode(); });

  // Error
  el['btn-retry'].addEventListener('click', goToSetup);
  el['btn-error-keyboard'].addEventListener('click', () => { ensureAudio(); startKeyboardMode(); });
  el['btn-error-menu'].addEventListener('click', goToIntro);

  // HUD
  el['btn-pause'].addEventListener('click', () => togglePause());
  el['btn-sound'].addEventListener('click', toggleSound);

  // Pause overlay
  el['btn-resume'].addEventListener('click', () => togglePause(false));
  el['btn-restart'].addEventListener('click', () => { state.paused = false; startMatch(); });
  el['btn-quit'].addEventListener('click', goToIntro);

  // Game over overlay
  el['btn-rematch'].addEventListener('click', () => startMatch());
  el['btn-change-diff'].addEventListener('click', goToIntro);
  el['btn-menu'].addEventListener('click', goToIntro);

  // Keyboard — pad1: WASD + Space (P1), pad2: Arrows + Enter (P2).
  // In single-player the arrows merge into pad1 so either works for P1.
  window.addEventListener('keydown', (e) => {
    const k = e.key;
    const merge = !twoPlayer();
    if (k === 'ArrowLeft') { pad2Keys.left = true; if (merge) pad1Keys.left = true; e.preventDefault(); }
    else if (k === 'ArrowRight') { pad2Keys.right = true; if (merge) pad1Keys.right = true; e.preventDefault(); }
    else if (k === 'ArrowUp') { pad2Keys.up = true; if (merge) pad1Keys.up = true; e.preventDefault(); }
    else if (k === 'ArrowDown') { pad2Keys.down = true; if (merge) pad1Keys.down = true; e.preventDefault(); }
    else if (k === 'a' || k === 'A') { pad1Keys.left = true; }
    else if (k === 'd' || k === 'D') { pad1Keys.right = true; }
    else if (k === 'w' || k === 'W') { pad1Keys.up = true; }
    else if (k === 's' || k === 'S') { pad1Keys.down = true; }
    else if (k === ' ') { pad1Keys.swing = 1; e.preventDefault(); }
    else if (k === 'Enter') { pad2Keys.swing = 1; e.preventDefault(); }
    else if (k === 'p' || k === 'P' || k === 'Escape') togglePause();
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key;
    const merge = !twoPlayer();
    if (k === 'ArrowLeft') { pad2Keys.left = false; if (merge) pad1Keys.left = false; }
    else if (k === 'ArrowRight') { pad2Keys.right = false; if (merge) pad1Keys.right = false; }
    else if (k === 'ArrowUp') { pad2Keys.up = false; if (merge) pad1Keys.up = false; }
    else if (k === 'ArrowDown') { pad2Keys.down = false; if (merge) pad1Keys.down = false; }
    else if (k === 'a' || k === 'A') { pad1Keys.left = false; }
    else if (k === 'd' || k === 'D') { pad1Keys.right = false; }
    else if (k === 'w' || k === 'W') { pad1Keys.up = false; }
    else if (k === 's' || k === 'S') { pad1Keys.down = false; }
  });
  window.addEventListener('blur', () => {
    for (const kp of [pad1Keys, pad2Keys]) {
      kp.left = kp.right = kp.up = kp.down = false;
    }
  });

  // Auto-pause when the tab is hidden.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.screen === 'play' && !state.paused && state.phase !== 'over') {
      togglePause(true);
    }
  });

  window.addEventListener('resize', layout);
}

/* ============================================================
   20. MAIN LOOP
   ============================================================ */

let lastTs = 0;

function update(dt, nowMs) {
  pumpTracking(nowMs);

  // Paddles follow hands on the setup screen too (live preview).
  if (state.screen === 'setup') {
    if (state.inputMode === 'hand') updateHandInput(dt);
    return;
  }
  if (state.screen !== 'play' || state.paused) return;

  if (state.inputMode === 'hand') updateHandInput(dt);
  else updateKeyboardInput(dt);
  updateHandHints();

  if (state.phase === 'countdown') {
    state.timer -= dt;
    const n = Math.max(1, Math.ceil(state.timer / COUNTDOWN_STEP));
    if (n !== state.lastCountdown) {
      state.lastCountdown = n;
      showBanner(String(n), twoPlayer() ? 'P1 vs P2 — first to 11' : 'First to 11 — win by 2');
      blip(440, 0.05, 'sine', 0.045);
    }
    if (state.timer <= 0) beginServe();
  } else if (state.phase === 'serve') {
    state.serveTimer += dt;
    const b = state.ball;
    const aiServing = state.serveSide === 'ai' && !twoPlayer();
    if (!aiServing) {
      // Human server (P1 or P2): the ball floats beside their paddle
      // until they swipe through it.
      const sp = serverPaddle();
      const side = sp === state.player ? -0.13 : 0.13;   // float on the outside
      b.x = sp.x + side;
      b.y = sp.y + 0.06;
      b.z = sp.z + (sp.z > 0 ? -0.2 : 0.2);              // float toward the net
      b.visible = true;
      if (sp.speed > 1.15 || state.serveTimer > AUTO_SERVE_S) launchServe();
    } else {
      // AI holds the ball, then serves.
      stepAI(dt);
      b.x = state.ai.x + 0.12;
      b.y = state.ai.y + 0.06;
      b.z = state.ai.z + 0.18;
      b.visible = true;
      if (state.serveTimer > AI_SERVE_DELAY) launchServe();
    }
  } else if (state.phase === 'rally') {
    stepPlayerHit(dt);
    stepAI(dt);
    stepBall(dt, true);
  } else if (state.phase === 'point') {
    state.timer -= dt;
    stepBall(dt, false);      // let the ball settle visually
    if (state.timer <= 0) afterPoint();
  }
}

function frame(ts) {
  const dt = Math.min(0.05, lastTs ? (ts - lastTs) / 1000 : 0.016);
  lastTs = ts;
  update(dt, ts);
  renderScene(dt);
  if (!el.preview.classList.contains('hidden')) drawPreview();
  syncHud();
  stepConfetti(dt);
  requestAnimationFrame(frame);
}

/* ============================================================
   21. TEST SEAM — used by verify.js / capture.js (?test=1)
   ============================================================ */

window.__airsmash = {
  state,
  TABLE,
  view,
  get renderer() { return world.renderer; },
  get camera() { return world.camera; },
  get camera2() { return world.camera2; },
  // Place a fake hand (normalized, mirrored coords: x 0..1 left→right, y 0..1 top→bottom).
  // Feeds player 1's hand slot.
  setFakeHand(x, y) { state.fakeHands = [{ x, y }]; },
  // Fake N hands at once: index 0 → P1, index 1 → P2 (two-player mode).
  setFakeHands(list) { state.fakeHands = list; },
  clearFakeHand() { state.fakeHands = null; },
  // Fake hand skeleton for screenshots (unmirrored landmark-style points).
  // Optional second arg selects the slot (default 0 = P1).
  setFakeLandmarks(pts, slot = 0) {
    (slot === 1 ? state.hand2 : state.hand).landmarks = pts;
  },
  // Simulated camera feed for screenshots (an offscreen canvas).
  setFakeBackground(canvas) { state.fakeBackground = canvas; },
  // End the match-start countdown immediately.
  skipCountdown() { if (state.phase === 'countdown') state.timer = 0; },
  // Launch the current serve immediately (whichever side).
  serveNow() { if (state.phase === 'serve') launchServe(); },
  // Award a point as if the rally had ended that way.
  forceScore(side) {
    if (state.phase === 'over' || state.phase === 'point') return;
    state.phase = 'rally';
    scorePoint(side);
  },
  // Place the ball mid-rally (for screenshots / physics tests).
  placeBall(x, y, z, vx, vy, vz, lastHitter = 'ai') {
    const b = state.ball;
    b.x = x; b.y = y; b.z = z;
    b.vx = vx; b.vy = vy; b.vz = vz;
    b.lastHitter = lastHitter;
    b.bounces = 0;
    b.validOpponentBounce = false;
    b.visible = true;
  },
  // Advance the whole match to game over (for screenshots/tests).
  finishMatch(winner) {
    state.phase = 'rally';
    let guard = 0;
    while (state.phase !== 'over' && guard++ < 60) {
      if (winner === 'you') state.scoreYou++; else state.scoreAI++;
      state.phase = 'point';
      afterPoint();
      if (state.phase === 'point') state.phase = 'rally';
    }
  },
};

/* ============================================================
   BOOT
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  cacheDom();
  previewCtx = el.preview.getContext('2d');
  confettiCtx = el.confetti.getContext('2d');

  try {
    initThree();
  } catch (err) {
    showError('Graphics unavailable', 'WebGL could not start in this browser (' + (err && err.message || 'unknown') + ').');
    return;
  }

  layout();
  loadGame();
  setMode(state.mode);
  setDifficulty(state.difficulty);
  syncSoundBtn();
  refreshIntroStats();
  syncOpponentVisibility();
  wireControls();
  showScreen('intro');
  requestAnimationFrame(frame);
});
