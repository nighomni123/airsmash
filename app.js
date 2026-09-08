/* ============================================================
   AirSmash — app.js  (3D first-person table tennis)
   Your hand is the paddle. Camera behind your end of the table,
   full view of the net, the opponent and the arena.
   Two-player modes:
     · 2 Players — one camera, split screen: P1 near end (left view),
       P2 far end (right view); each hand owns half of the camera.
     · LAN 2P    — two devices on one network (lan-server.js): each
       tracks its own hand, host simulates, guest renders.

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
    21. LAN multiplayer  — two devices over WebSocket (lan-server.js)
    22. Test seam        — window.__airsmash (used by verify/capture)
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

// Adaptive capture: inference runs on a downscaled crop, not the full
// 640x480 feed. TRACK_W adapts to measured round-trip time so a 2019
// laptop and a mid-range Android share one code path (start high on
// desktop, low on coarse pointers; step down when slow, up when fast).
const TRACK_W_DESKTOP = 320;
const TRACK_W_MOBILE = 256;
const TRACK_W_MIN = 192;
const TRACK_W_MAX = 384;
const TRACK_ASPECT = 3 / 4;                    // inference bitmap h = w * aspect (4:3 feed)
const ROI_HALF = 0.30;                         // ROI half-size (fraction of frame) around last hand
const INFER_MIN_MS = 60;                       // fastest inference send rate (1/60Hz frame; smoothing interpolates)
const INFER_MAX_MS = 140;                      // slowest when backed up
const INFLIGHT_TIMEOUT_MS = 500;               // stuck snapshot watchdog (frees a dead transfer)
const SYNC_FALLBACK_MS = 100;                  // main-thread detectForVideo cap (~10fps — it blocks render)
const RTT_SLOW_MS = 70;                        // step resolution down above this
const RTT_FAST_MS = 35;                        // step resolution up below this
const RTT_SLOW_FRAMES = 30;
const RTT_FAST_FRAMES = 180;

// P1-only table-tennis gestures (power + direction, no spin system).
// Punch gain maps hand-size growth (moving toward camera) to power;
// roll gain maps wrist roll to aim trim; reach bonus lets a punch
// stretch the hit radius slightly.
const PUNCH_GAIN = 0.9;
const ROLL_GAIN = 0.45;
const FIST_POWER_BONUS = 0.22;
const PUNCH_REACH_BONUS = 0.06;
const GRIP_FIST_RATIO = 0.50;                  // avg tip-pip dist / palmSize below this = fist

// P1 calibration (setup screen): hold neutral, then one practice swing.
const CALIB_HOLD_S = 2.0;
const CALIB_HOLD_S_TEST = 0.5;                 // hermetic runs stay fast
const CALIB_STILL = 0.75;                      // smoothed motion below this = steady
const CALIB_SWING = 1.7;                       // smoothed motion above this = swing seen
const CALIB_DEFAULT_SIZE = 0.09;               // fallback palm size (normalized)

// Optional body lean (pose worker, default off, fail-soft).
const POSE_KEY = 'airsmash.pose.v1';
const POSE_W = 192;                            // tiny full-frame bitmap for torso
const POSE_INTERVAL_MS = 125;                  // ~8fps is plenty for lean + arm fallback
const POSE_GAIN = 0.30;                        // shoulder offset (normalized) -> meters
const POSE_TRIM_MAX = 0.15;

// Arm fallback (wrist tracking when the palm model loses the hand).
// The pose wrist survives fist rotation, motion blur and partial
// occlusion far better than the 21-point hand skeleton, so P1 keeps
// moving instead of coasting. Single person per camera only (ai/lan);
// 2p stays palm-only to avoid cross-talk between two bodies.
const ARM_FRESH_MS = 600;                      // wrist sample usable this long
const ARM_MIN_VIS = 0.25;                      // min landmark visibility to trust
const ARM_ROLL_GAIN = 0.35;                    // forearm-angle aim trim (vs ROLL_GAIN palm)
const ARM_PALM_OFFSET = 0.035;                 // wrist→palm estimate along forearm dir
const ARM_SWITCH_MARGIN = 0.08;                // hysteresis when picking L/R wrist

// Paddle workspace (world meters). P1 lives on the near rail (+z); in
// two-player, P2 takes the far rail (−z) — real opposite-ends play.
const PADDLE_X_RANGE = 1.05;
const PADDLE_Y_TOP = 1.62, PADDLE_Y_BOT = 0.82;
const PADDLE_Z = 1.30;                         // near rail (P1 / the human in VS-AI) — just inside the table edge
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

// Bullet-time approach window: an incoming ball inside a HUMAN receiver's
// strike zone glides in slow motion while the player's hand, camera and
// the AI keep running at full speed — a brief window to line the paddle
// up with the ball. Ball-time only; never applied to the bot's receiving
// half, so the AI always plays full-speed shots at full speed.
const SLOWMO_SCALE = 0.35;    // ball-time fraction deep in the zone (~3× longer to align)
const SLOWMO_ZONE_Z = 0.22;   // strike-zone entry just past the net (matches the hit gates)
const SLOWMO_RATE = 10;       // ball-time easing rate per second (smooth in, smooth out)

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
const PREVIEW_INTERVAL_MS = 33;                // PiP redraw cap on setup (~30fps for calibration)
const PREVIEW_PLAY_MS = 125;                   // PiP redraw cap during play (~8fps corner mirror is plenty)

// LAN multiplayer (two devices, host-authoritative).
const LAN_STATE_MS = 50;                       // host → guest state broadcast interval
const LAN_PAD_MS = 33;                         // guest → host paddle update interval

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
  mode: 'ai',                // ai = vs AI | 2p = two humans, one camera | lan = two devices

  // LAN multiplayer (mode 'lan'). role: 'p1' hosts + simulates, 'p2'
  // renders the far POV and streams its paddle to the host.
  lan: {
    ws: null,
    role: null,              // 'p1' | 'p2' | null (unassigned)
    connected: false,        // peer present in the room
    peerReady: false,
    relayUrl: null,          // resolved relay WebSocket URL; null = same-origin /ws
    remoteMsg: null,         // newest host→guest state snapshot
    remotePad: null,         // newest guest→host paddle sample
    lastPadSent: 0,
    lastStateSent: 0,
    lastReadySent: null,
  },

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

  // Bullet-time approach window: ball-time dilation factor (1 = real time).
  slowMo: 1,

  // Near/far paddles. Internal ids match the scoring keys:
  // player.id='you' (player 1, near rail), p2.id='ai' (player 2 in 2p,
  // far rail), ai.id='ai' (the bot). Scoring/HUD code never needs to know.
  player: { id: 'you', x: 0, y: 1.1, z: PADDLE_Z, railZ: PADDLE_Z, vx: 0, vy: 0, vz: 0, speed: 0, targetX: 0, targetY: 1.1, hitCooldown: 0 },
  p2:      { id: 'ai',  x: 0, y: 1.0, z: PADDLE_Z_FAR, railZ: PADDLE_Z_FAR, vx: 0, vy: 0, vz: 0, speed: 0, targetX: 0, targetY: 1.0, hitCooldown: 0 },
  ai: { id: 'ai', x: 0, y: 1.0, z: -1.15, vx: 0, targetX: 0, targetY: 1.0, hitCooldown: 0, reactT: 0, aimErrX: 0, aimErrZ: 0, predAt: 0, predStamp: '' },

  // Hand tracking — one slot per player (slot 1 only used in 2p mode).
  // Gestures + calibration are P1-only (slot 0); slot 1 stays centroid.
  hand: makeHandSlot(),
  hand2: makeHandSlot(),
  fakeHands: null,           // test seam: [{ x, y }, …] normalized mirrored coords
  fakeBackground: null,      // test seam: canvas used as simulated camera feed

  // Adaptive capture telemetry (dev-only, exposed via __airsmash).
  perf: {
    rtt: 0, inferMs: 0, sentFps: 0, dropped: 0,
    trackW: 0, lastSendMs: 0, slowFrames: 0, fastFrames: 0,
    sends: 0, fpsWindowStart: 0,
    // Frame-pacing monitor (rAF deltas — what the player actually sees).
    frameEmaMs: 16.7, frameWorstMs: 0, slowFrameCount: 0,
    inflightResets: 0, syncRuns: 0,
    longtasks: 0, longtaskMaxMs: 0,
    // Shadow map update throttling
    frameCount: 0,
  },

  // P1 calibration state machine: idle | hold | swing | done | skipped.
  calibPhase: 'idle',

  // Optional body lean (pose worker, default off) + arm fallback state.
  // pose.arm holds the picked playing-arm wrist/elbow (MIRRORED x, like
  // hand slots) plus raw joints for the PiP overlay (unmirrored).
  pose: {
    enabled: false, ready: false, lean: 0, lastLean: 0,
    armSide: null,                          // 'l' | 'r' | null (stickiness)
    arm: { x: 0.5, y: 0.7, ex: 0.5, ey: 0.7, present: false, vis: 0, lastSeenMs: -1e9 },
    armPts: null,                           // {sx,sy,ex,ey,wx,wy} unmirrored for PiP
  },

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
    handedness: null,        // 'Left' | 'Right' | null (worker-provided)
    trackSrc: 'none',        // 'palm' | 'arm' | 'none' — what drives this slot now
    // P1 calibration snapshot (session-only, not persisted).
    calib: {
      done: false, size: 0, x: 0.5, y: 0.7, thumbSide: 0, maxSpeed: 0,
      holdT: 0, holdSum: 0, holdN: 0,
    },
    // P1 gesture output (power + direction only).
    gesture: { powerMul: 1, aimXTrim: 0, punch: 0, roll: 0, facing: 'unknown', fist: false },
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
    'mode-seg', 'mode-hint', 'difficulty-block', 'lan-note',
    'relay-row', 'relay-input', 'lan-code',
    'difficulty-seg', 'btn-start', 'stat-wins', 'stat-losses', 'stat-rally',
    'pose-opt',
    'setup-status', 'setup-progress', 'setup-progress-bar',
    'calib-block', 'calib-status', 'calib-bar', 'btn-calib-skip',
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
    if (data.mode === 'ai' || data.mode === '2p' || data.mode === 'lan') state.mode = data.mode;
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
  el.preview.classList.toggle('split', state.mode === '2p');   // LAN shows one POV per device

  if (name !== 'play') {
    el['hand-hint'].classList.add('hidden');
    el.banner.classList.add('hidden');
  }
}

// Display names for the two sides, per mode. Internal keys stay
// 'you'/'ai' everywhere (scoring, ball.lastHitter); only text differs.
function sideLabel(side) {
  if (state.mode === 'ai') return side === 'you' ? 'You' : 'AI';
  return side === 'you' ? 'Player 1' : 'Player 2';
}

function syncModeUi() {
  for (const btn of el['mode-seg'].querySelectorAll('button')) {
    const on = btn.dataset.mode === state.mode;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-checked', String(on));
  }
  el['difficulty-block'].classList.toggle('hidden', state.mode !== 'ai');
  if (el['relay-row']) el['relay-row'].classList.toggle('hidden', state.mode !== 'lan');
  if (el['mode-hint']) {
    el['mode-hint'].textContent =
      state.mode === '2p'
        ? 'Split screen — P1 plays from the near end (left view), P2 from the far end (right view). Each hand uses half of the camera.'
        : state.mode === 'lan'
          ? 'Two devices, one relay — run `node lan-server.js`, or point the box below at a hosted relay.'
          : 'One hand is your paddle.';
  }
}

function setMode(mode) {
  if (mode !== 'ai' && mode !== '2p' && mode !== 'lan') return;
  if (state.mode === 'lan' && mode !== 'lan') lanTeardown();
  state.mode = mode;
  syncModeUi();
  saveGame();
}

function refreshIntroStats() {
  el['stat-wins'].textContent = state.stats.wins;
  el['stat-losses'].textContent = state.stats.losses;
  el['stat-rally'].textContent = state.stats.bestRally;
}

function goToIntro(notifyPeer = true) {
  if (notifyPeer && isLan() && state.lan.connected && state.screen === 'play') {
    lanSend({ t: 'quit' });   // let the other device bow out too
  }
  state.paused = false;
  state.phase = 'idle';
  if (!state.pose.enabled) stopPoseWorker();   // menu needs no tracking workers
  refreshIntroStats();
  syncSoundBtn();
  syncModeUi();
  showScreen('intro');
}

function resetCalibration() {
  state.calibPhase = 'idle';
  for (const s of [state.hand, state.hand2]) {
    s.calib.done = false;
    s.calib.size = 0;
    s.calib.thumbSide = 0;
    s.calib.maxSpeed = 0;
    s.calib.holdT = 0;
    s.calib.holdSum = 0;
    s.calib.holdN = 0;
  }
  if (el['calib-block']) el['calib-block'].classList.add('hidden');
}

function calibHoldTarget() {
  return TEST_MODE ? CALIB_HOLD_S_TEST : CALIB_HOLD_S;
}

function p1NeedsCalibration() {
  if (state.inputMode !== 'hand') return false;
  if (TEST_MODE) return false;   // hermetic runs stay fast (covered by unit checks)
  if (isLan() && state.lan.role === 'p2') return false;   // P1-only: guest skips
  return !state.hand.calib.done;
}

function captureNeutralFromP1() {
  const s = state.hand;
  const size = (s.landmarks && palmSizeOf(s.landmarks)) || CALIB_DEFAULT_SIZE;
  let thumbSide = 0;
  try {
    if (s.landmarks && s.landmarks.length >= 21) {
      const tmx = 1 - s.landmarks[4].x, ptx = 1 - s.landmarks[20].x;
      thumbSide = Math.sign(tmx - ptx) || 0;
    }
  } catch { thumbSide = 0; }
  s.calib.size = size > 1e-6 ? size : CALIB_DEFAULT_SIZE;
  s.calib.thumbSide = thumbSide;
  s.calib.x = s.smX;
  s.calib.y = s.smY;
}

function skipCalibration() {
  const s = state.hand;
  if (!s.calib.size) s.calib.size = (s.landmarks && palmSizeOf(s.landmarks)) || CALIB_DEFAULT_SIZE;
  s.calib.done = true;
  state.calibPhase = 'done';
  if (el['calib-block']) el['calib-block'].classList.add('hidden');
  setupReadyCheck();
}

// Per-frame calibration advance on the setup screen (P1-only).
function updateCalibration(dt) {
  if (state.screen !== 'setup') return;
  if (state.inputMode !== 'hand') return;
  if (TEST_MODE) return;
  if (isLan() && state.lan.role === 'p2') return;
  const s = state.hand;
  if (s.calib.done) {
    if (state.calibPhase !== 'done') state.calibPhase = 'done';
    return;
  }
  if (!s.everDetected) { state.calibPhase = 'idle'; return; }
  if (state.calibPhase === 'idle') state.calibPhase = 'hold';
  if (state.calibPhase === 'hold') {
    if (s.detected && s.motion < CALIB_STILL) {
      s.calib.holdT += dt;
      s.calib.holdSum += palmSizeOf(s.landmarks) || 0;
      s.calib.holdN++;
    } else if (!s.detected) {
      s.calib.holdT = Math.max(0, s.calib.holdT - dt * 2);
    }
    if (s.calib.holdT >= calibHoldTarget()) {
      captureNeutralFromP1();
      state.calibPhase = 'swing';
    }
  } else if (state.calibPhase === 'swing') {
    if (s.motion > s.calib.maxSpeed) s.calib.maxSpeed = s.motion;
    if (s.motion >= CALIB_SWING || state.player.speed >= CALIB_SWING) {
      s.calib.done = true;
      state.calibPhase = 'done';
      if (el['calib-block']) el['calib-block'].classList.add('hidden');
      try { blip(660, 0.07, 'sine', 0.05); } catch { /* ignore */ }
    }
  }
  updateCalibUi();
  setupReadyCheck();
}

function updateCalibrationTick() {
  // Lightweight: refresh calibration button text right when a hand lands.
  if (state.screen !== 'setup' || TEST_MODE) return;
  updateCalibUi();
}

function updateCalibUi() {
  const box = el['calib-block'];
  if (!box) return;
  if (TEST_MODE) { box.classList.add('hidden'); return; }
  if (state.inputMode !== 'hand' || !state.hand.everDetected || state.hand.calib.done) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  const bar = el['calib-bar'], status = el['calib-status'];
  if (state.calibPhase === 'hold') {
    const f = Math.min(1, state.hand.calib.holdT / calibHoldTarget());
    if (bar) bar.style.width = Math.round(f * 55) + '%';
    if (status) status.textContent = 'Hold your open palm steady… (' + Math.round(f * 100) + '%)';
  } else if (state.calibPhase === 'swing') {
    if (bar) bar.style.width = '72%';
    if (status) status.textContent = 'Now one practice swing — swipe through like a forehand.';
  }
}

/* ---------- Optional body lean (pose worker, default off) ----------
   Separate tiny worker + lite model at ~8fps. Fail-soft: any error just
   disables lean and the hand game continues untouched. P1-only. */
let poseWorker = null;
let poseReady = false;
let poseDead = false;
let poseInFlight = false;
let poseLastSend = 0;

function loadPoseOpt() {
  try {
    return localStorage.getItem(POSE_KEY) === '1';
  } catch { return false; }
}

function savePoseOpt(on) {
  try {
    if (on) localStorage.setItem(POSE_KEY, '1');
    else localStorage.removeItem(POSE_KEY);
  } catch { /* ignore */ }
}

function initPoseIfWanted() {
  state.pose.enabled = loadPoseOpt();
  if (el['pose-opt']) el['pose-opt'].checked = state.pose.enabled;
  if (state.pose.enabled && !TEST_MODE) startPoseWorker();
  else stopPoseWorker();
}

function setPoseOpt(on) {
  state.pose.enabled = !!on;
  savePoseOpt(state.pose.enabled);
  if (state.pose.enabled && !TEST_MODE && state.screen === 'setup') startPoseWorker();
  else if (!state.pose.enabled) stopPoseWorker();
  toast(state.pose.enabled ? 'Body lean on (beta) — lean to nudge aim' : 'Body lean off');
}

function startPoseWorker() {
  if (poseWorker || poseDead || TEST_MODE) return;
  try {
    poseWorker = new Worker('pose-worker.js', { type: 'module' });
  } catch { poseDead = true; return; }
  poseWorker.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'ready') { poseReady = true; state.pose.ready = true; }
    else if (m.type === 'error') { poseDead = true; stopPoseWorker(); }
    else if (m.type === 'result') {
      poseInFlight = false;
      try {
        const lean = typeof m.lean === 'number' ? m.lean : 0;
        const c = Math.abs(lean) < 0.5 ? lean : 0;
        state.pose.lastLean = state.pose.lean;
        state.pose.lean += (c - state.pose.lean) * 0.35;
      } catch { /* ignore */ }
      try { applyPoseArm(m.arm); } catch { /* arm must never break lean */ }
    }
  };
  poseWorker.onerror = () => { poseDead = true; stopPoseWorker(); };
  try { poseWorker.postMessage({ type: 'init' }); } catch { poseDead = true; stopPoseWorker(); }
  // Timeout: never leave the lobby waiting on pose.
  setTimeout(() => {
    if (!poseReady) { poseDead = true; stopPoseWorker(); }
  }, 15000);
}

function stopPoseWorker() {
  poseReady = false;
  state.pose.ready = false;
  state.pose.lean = 0;
  state.pose.arm.present = false;
  state.pose.arm.vis = 0;
  state.pose.armSide = null;
  state.pose.armPts = null;
  if (poseWorker) { try { poseWorker.terminate(); } catch { /* ignore */ } }
  poseWorker = null;
  poseInFlight = false;
}

// Arm fallback needs the pose worker even when the lean toggle is off —
// it only runs in hand mode with one person per camera (ai/lan), never
// in 2p (two bodies, one pose slot → cross-talk risk).
function armTrackingWanted() {
  return state.inputMode === 'hand' && !twoPlayer() && !TEST_MODE;
}

function ensureArmWorker() {
  if (TEST_MODE || poseWorker || poseDead) return;
  if (state.inputMode === 'hand' && !twoPlayer()) startPoseWorker();
}

// Pick the playing-arm wrist (mirrored coords) with stickiness: keep the
// current side unless the other wrist is clearly closer to P1's last
// known spot. Stores mirrored wrist + elbow for the input path and raw
// joints for the PiP overlay.
function applyPoseArm(arm) {
  const st = state.pose.arm;
  if (!arm || (!arm.lw && !arm.rw)) return;
  const s = state.hand;
  const cand = [];
  const vis = (p) => (p && typeof p.v === 'number' ? p.v : 1);
  if (arm.lw && vis(arm.lw) >= ARM_MIN_VIS) {
    cand.push({ side: 'l', mx: 1 - arm.lw.x, my: arm.lw.y, w: arm.lw, e: arm.le });
  }
  if (arm.rw && vis(arm.rw) >= ARM_MIN_VIS) {
    cand.push({ side: 'r', mx: 1 - arm.rw.x, my: arm.rw.y, w: arm.rw, e: arm.re });
  }
  if (!cand.length) return;
  let pick = cand[0];
  if (cand.length > 1) {
    const d = (c) => Math.hypot(c.mx - s.assignX, c.my - s.assignY);
    const cur = cand.find((c) => c.side === state.pose.armSide);
    if (cur && d(cur) <= Math.min(d(cand[0]), d(cand[1])) + ARM_SWITCH_MARGIN) {
      pick = cur;
    } else {
      pick = d(cand[0]) <= d(cand[1]) ? cand[0] : cand[1];
    }
  }
  state.pose.armSide = pick.side;
  // Nudge the wrist toward the palm along the forearm so palm↔arm
  // handoffs don't jump (~3.5cm in normalized units).
  let px = pick.mx, py = pick.my;
  try {
    if (pick.e) {
      const ex = 1 - pick.e.x, ey = pick.e.y;
      const dx = pick.mx - ex, dy = pick.my - ey;
      const len = Math.hypot(dx, dy);
      if (len > 1e-4) {
        px = clampNum(pick.mx + (dx / len) * ARM_PALM_OFFSET, 0, 1);
        py = clampNum(pick.my + (dy / len) * ARM_PALM_OFFSET, 0, 1);
      }
      st.ex = ex; st.ey = ey;
    }
  } catch { /* keep raw wrist */ }
  st.x = px; st.y = py;
  st.vis = vis(pick.w);
  st.present = true;
  st.lastSeenMs = performance.now();
  try {
    state.pose.armPts = {
      wx: pick.w.x, wy: pick.w.y,
      ex: pick.e ? pick.e.x : null, ey: pick.e ? pick.e.y : null,
      sx: (arm.ls && arm.rs) ? ((arm.ls.x + arm.rs.x) / 2) : null,
      sy: (arm.ls && arm.rs) ? ((arm.ls.y + arm.rs.y) / 2) : null,
    };
  } catch { state.pose.armPts = null; }
}

// Fresh wrist sample available for the fusion path (or null).
function getFreshArm() {
  const st = state.pose.arm;
  if (!st.present) return null;
  if (performance.now() - st.lastSeenMs > ARM_FRESH_MS) return null;
  if (!(st.vis >= ARM_MIN_VIS)) return null;
  return st;
}

// Forearm angle in mirrored space → paddle roll when the palm is gone.
function armRoll() {
  try {
    const st = state.pose.arm;
    const dxm = st.x - (st.ex !== undefined ? st.ex : st.x);
    const dym = st.y - (st.ey !== undefined ? st.ey : st.y);
    if (Math.hypot(dxm, dym) < 1e-4) return 0;
    return clampNum(Math.atan2(dxm, -dym), -0.7, 0.7);
  } catch { return 0; }
}

function pumpPoseTracking(nowMs) {
  if ((!state.pose.enabled && !armTrackingWanted()) || !poseReady || poseInFlight || TEST_MODE) return;
  if (!video || video.readyState < 2 || !video.videoWidth) return;
  if (nowMs - poseLastSend < POSE_INTERVAL_MS) return;
  if (typeof createImageBitmap !== 'function') return;
  poseLastSend = nowMs;
  poseInFlight = true;
  createImageBitmap(video, { resizeWidth: POSE_W, resizeHeight: Math.round(POSE_W * TRACK_ASPECT) })
    .then((bmp) => {
      if (!poseWorker) { if (bmp && bmp.close) bmp.close(); poseInFlight = false; return; }
      poseWorker.postMessage({ type: 'frame', bitmap: bmp, ts: Math.floor(nowMs) }, [bmp]);
    })
    .catch(() => { poseInFlight = false; });
}

function goToSetup() {
  state.inputMode = 'hand';
  state.hand.everDetected = false;
  state.hand2.everDetected = false;
  resetCalibration();
  el['btn-start-match'].disabled = true;
  el['btn-start-match'].textContent = twoPlayer() ? 'Waiting for both hands…' : 'Waiting for hand…';
  el['setup-progress'].classList.remove('hidden');
  el['lan-note'].classList.toggle('hidden', !isLan());
  setSetupStatus('Starting camera…');
  showScreen('setup');
  if (isLan()) lanBeginSetup();
  initCameraAndModel();
  initPoseIfWanted();
  ensureArmWorker();   // wrist fallback runs even with the lean toggle off
}

function twoPlayer() { return state.mode === '2p'; }
function isLan() { return state.mode === 'lan'; }
// Modes where the far side is a human, not the bot.
function hasBot() { return state.mode === 'ai'; }
// LAN: which paddle does THIS device control? P2 = far rail.
function myPaddle() { return state.lan.role === 'p2' ? state.p2 : state.player; }

function setSetupStatus(msg) { el['setup-status'].textContent = msg; }

function setSetupProgress(frac) {
  el['setup-progress-bar'].style.width = Math.round(frac * 100) + '%';
}

function setupReadyCheck() {
  if (state.screen !== 'setup') return;
  if (isLan()) { lanSetupReadyCheck(); return; }
  if (state.cameraReady && state.modelReady) {
    setSetupProgress(1);
    el['setup-progress'].classList.add('hidden');
    setSetupStatus(twoPlayer() ? 'Camera ready — show both hands ✋✋' : 'Camera ready — show your hand or forearm ✋');
  }
  const handsReady = twoPlayer()
    ? (state.hand.everDetected && state.hand2.everDetected)
    : state.hand.everDetected;
  const calibOk = state.inputMode !== 'hand' || TEST_MODE || state.hand.calib.done;
  const ready = handsReady && calibOk;
  const btn = el['btn-start-match'];
  if (ready) {
    btn.disabled = false;
    btn.textContent = 'Start match';
  } else if (handsReady && !calibOk) {
    btn.disabled = true;
    btn.textContent = state.calibPhase === 'swing' ? 'Do a practice swing…' : 'Hold steady to calibrate…';
  } else {
    btn.disabled = true;
    btn.textContent = twoPlayer() ? 'Waiting for both hands…' : 'Waiting for hand…';
  }
  updateCalibUi();
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
      ? (state.mode === '2p' ? 'Camera ready — show both hands ✋✋' : 'Camera ready — show your hand ✋')
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
let pendingRoi = null;          // ROI fractions used for the in-flight frame
let pendingTs = 0;
let sentAtMs = 0;               // when the in-flight snapshot was posted
let lastSyncMs = 0;             // last main-thread fallback inference
let videoFrameReady = false;    // set by requestVideoFrameCallback when available
let rvfcArmed = false;

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
        // Round-trip time drives adaptive resolution + send-rate.
        const now = performance.now();
        const rtt = Math.max(0, now - (m.ts || now));
        state.perf.rtt += (rtt - state.perf.rtt) * 0.15;
        if (typeof m.inferMs === 'number') state.perf.inferMs = m.inferMs;
        adaptTrackW();
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

// Adaptive capture helpers. One pipeline serves both a 2019 laptop and a
// mid-range Android: downscaled ROI crops + send-rate throttle driven by
// measured worker round-trip time.
function initialTrackW() {
  if (state.perf.trackW) return state.perf.trackW;
  let w = TRACK_W_DESKTOP;
  try {
    if (matchMedia('(pointer: coarse)').matches) w = TRACK_W_MOBILE;
    else if ((navigator.hardwareConcurrency || 8) <= 4) w = TRACK_W_MOBILE;
  } catch { /* ignore */ }
  state.perf.trackW = w;
  return w;
}

function adaptTrackW() {
  const rtt = state.perf.rtt;
  if (rtt > RTT_SLOW_MS) {
    state.perf.slowFrames++;
    state.perf.fastFrames = 0;
  } else if (rtt < RTT_FAST_MS) {
    state.perf.fastFrames++;
    state.perf.slowFrames = 0;
  } else {
    state.perf.slowFrames = 0;
    state.perf.fastFrames = 0;
  }
  const w = initialTrackW();
  if (state.perf.slowFrames >= RTT_SLOW_FRAMES && w > TRACK_W_MIN) {
    state.perf.trackW = w === TRACK_W_MAX ? TRACK_W_DESKTOP : TRACK_W_MIN;
    if (w === TRACK_W_DESKTOP) state.perf.trackW = TRACK_W_MOBILE;
    else if (w === TRACK_W_MOBILE) state.perf.trackW = TRACK_W_MIN;
    state.perf.slowFrames = 0;
  } else if (state.perf.fastFrames >= RTT_FAST_FRAMES && w < TRACK_W_DESKTOP) {
    state.perf.trackW = w === TRACK_W_MIN ? TRACK_W_MOBILE : TRACK_W_DESKTOP;
    state.perf.fastFrames = 0;
  }
}

function inferIntervalMs() {
  // Backed-up worker → slow down sends; healthy worker → up to ~30fps.
  const rtt = state.perf.rtt || 0;
  return Math.min(INFER_MAX_MS, Math.max(INFER_MIN_MS, INFER_MIN_MS + rtt * 0.5));
}

// ROI around P1's last known hand — or the wrist when the palm is gone
// (unmirrored video fractions). Full-frame when both are lost so
// re-acquisition still works.
function computeTrackRoi() {
  const s = state.hand;
  let cx, cy;   // mirrored coords of the thing to follow
  if (s.detected) { cx = s.assignX; cy = s.assignY; }
  else if (!twoPlayer()) {
    const arm = getFreshArm();
    if (arm) { cx = arm.x; cy = arm.y; }
    else if (performance.now() - s.lastSeenMs < ASSIGN_MEMORY_MS) { cx = s.assignX; cy = s.assignY; }
    else return null;
  }
  else if (performance.now() - s.lastSeenMs < ASSIGN_MEMORY_MS) { cx = s.assignX; cy = s.assignY; }
  else return null;
  const vx = 1 - cx;   // mirrored slot -> unmirrored video x
  const vy = cy;
  const w = ROI_HALF * 2, h = ROI_HALF * 2;
  const x = Math.min(1 - w, Math.max(0, vx - ROI_HALF));
  const y = Math.min(1 - h, Math.max(0, vy - ROI_HALF));
  return { x, y, w, h };
}

function armVideoCallback() {
  if (rvfcArmed || !video || typeof video.requestVideoFrameCallback !== 'function') return;
  rvfcArmed = true;
  const tick = () => {
    videoFrameReady = true;
    try { video.requestVideoFrameCallback(tick); } catch { /* ignore */ }
  };
  try { video.requestVideoFrameCallback(tick); } catch { rvfcArmed = false; }
}

// Called once per animation frame: feed the tracker + consume results.
function pumpTracking(nowMs) {
  if (TEST_MODE) { applyFakeHands(); return; }

  // Consume the newest worker result (never blocks — it's already done).
  if (latestTracking) {
    const m = latestTracking;
    latestTracking = null;
    // Map ROI-crop coords back to full-frame video coords (in-place to avoid GC churn).
    // Worker may send packed Float32Array (pts/nHands) — decode; legacy m.hands still accepted.
    let hands;
    if (m.pts instanceof Float32Array) {
      const n = m.nHands | 0; hands = new Array(n);
      const names = Array.isArray(m.handNames) ? m.handNames : null;
      const leg = Array.isArray(m.hands) ? m.hands : null;
      for (let hi = 0; hi < n; hi++) {
        const base = hi * 63; const arr = new Array(21);
        for (let i = 0; i < 21; i++) {
          const j = base + i * 3;
          arr[i] = { x: m.pts[j], y: m.pts[j + 1], z: m.pts[j + 2] };
        }
        let hn = names ? names[hi] : null;
        if (hn == null && leg && leg[hi]) hn = (typeof leg[hi] === 'string') ? leg[hi] : (leg[hi].hand || null);
        hands[hi] = { pts: arr, hand: hn };
      }
    } else { hands = m.hands || []; }
    const roi = m.roi || (m.ts === pendingTs ? pendingRoi : null);
    if (roi && hands.length) {
      const rx = roi.x, ry = roi.y, rw = roi.w, rh = roi.h;
      for (let hi = 0; hi < hands.length; hi++) {
        const h = hands[hi];
        const pts = Array.isArray(h) ? h : (h.pts || h.landmarks || []);
        for (let pi = 0; pi < pts.length; pi++) {
          const p = pts[pi];
          p.x = rx + (p.x || 0) * rw;
          p.y = ry + (p.y || 0) * rh;
        }
      }
    }
    const handed = m.handed || null;
    applyTracking(hands, nowMs, handed);
    if (m.ts === pendingTs) pendingRoi = null;
  }

  if (!video || video.readyState < 2 || !video.videoWidth) return;
  armVideoCallback();
  let newFrame = false;
  if (typeof video.requestVideoFrameCallback === 'function') {
    newFrame = videoFrameReady;
    if (newFrame) { videoFrameReady = false; lastVideoTime = video.currentTime; }
  } else {
    if (video.currentTime !== lastVideoTime) { newFrame = true; lastVideoTime = video.currentTime; }
  }
  // Watchdog: a result that never arrives (dead worker, dropped transfer)
  // must not freeze tracking forever — the paddle would coast mid-rally.
  if (bitmapInFlight && nowMs - sentAtMs > INFLIGHT_TIMEOUT_MS) {
    bitmapInFlight = false;
    pendingRoi = null;
    state.perf.inflightResets++;
    state.perf.dropped++;
  }
  // Stagger the pose feed off hand-snapshot frames so two bitmap captures
  // + transfers + inference wakeups never bunch into a single frame.
  const handDue = newFrame && !state.paused &&
    (nowMs - state.perf.lastSendMs >= inferIntervalMs());
  if (!handDue) pumpPoseTracking(nowMs);
  if (state.paused) return;   // consume results while paused, but don't spend CPU
  if (!handDue) return;

  if (workerReady && !bitmapInFlight && typeof createImageBitmap === 'function') {
    const roi = computeTrackRoi();
    const vw = video.videoWidth, vh = video.videoHeight;
    const trackW = initialTrackW();
    const trackH = Math.round(trackW * TRACK_ASPECT);
    bitmapInFlight = true;
    state.perf.lastSendMs = nowMs;
    let p;
    try {
      if (roi) {
        const sx = Math.round(roi.x * vw), sy = Math.round(roi.y * vh);
        const sw = Math.max(2, Math.round(roi.w * vw)), sh = Math.max(2, Math.round(roi.h * vh));
        p = createImageBitmap(video, sx, sy, sw, sh, { resizeWidth: trackW, resizeHeight: trackH });
      } else {
        p = createImageBitmap(video, { resizeWidth: trackW, resizeHeight: trackH });
      }
    } catch {
      try { p = Promise.resolve(null); } catch { bitmapInFlight = false; return; }
    }
    Promise.resolve(p).then((bmp) => {
      if (!bmp) {
        // Crop/resize path unsupported → fall back to a full-frame snapshot.
        createImageBitmap(video).then((full) => {
          trackTs = Math.max(trackTs + 1, Math.floor(performance.now()));
          pendingTs = trackTs; pendingRoi = null;
          state.perf.sends++;
          trackingWorker.postMessage({ type: 'frame', bitmap: full, ts: trackTs, roi: null }, [full]);
        }).catch(() => { bitmapInFlight = false; });
        return;
      }
      trackTs = Math.max(trackTs + 1, Math.floor(performance.now()));
      pendingTs = trackTs; pendingRoi = roi;
      sentAtMs = nowMs;
      state.perf.sends++;
      const wantHands = state.mode === 'ai' ? 1 : 2;
      try {
        trackingWorker.postMessage({ type: 'frame', bitmap: bmp, ts: trackTs, roi, numHands: wantHands }, [bmp]);
      } catch { bitmapInFlight = false; pendingRoi = null; }   // posting to a dead worker must not wedge tracking
    }).catch(() => { bitmapInFlight = false; });
    return;
  }

  // Worker unavailable → synchronous main-thread inference (fallback).
  // Throttled: detectForVideo BLOCKS the render loop, so never run it
  // faster than ~15fps even when camera frames arrive at 30-60fps.
  if (!workerReady && nowMs - lastSyncMs >= SYNC_FALLBACK_MS) {
    lastSyncMs = nowMs;
    if (syncLandmarker) {
      state.perf.syncRuns++;
      runSyncDetection(nowMs);
    } else if (workerDead) {
      ensureSyncLandmarker().then((lm) => { if (lm) { state.perf.syncRuns++; runSyncDetection(performance.now()); } });
    }
  }
}

let syncCanvas = null;
function syncDetectSource() {
  try {
    if (!syncCanvas) {
      syncCanvas = document.createElement('canvas');
      syncCanvas.width = 160; syncCanvas.height = 120;
    }
    const c = syncCanvas.getContext('2d', { alpha: false });
    c.drawImage(video, 0, 0, 160, 120);
    return syncCanvas;
  } catch { return video; }
}
function runSyncDetection(nowMs) {
  let result = null;
  try {
    trackTs = Math.max(trackTs + 1, Math.floor(performance.now()));
    try {
      result = syncLandmarker.detectForVideo(syncDetectSource(), trackTs);
    } catch {
      result = syncLandmarker.detectForVideo(video, trackTs);
    }
  } catch { return; }
  const hands = [];
  const lms = (result && result.landmarks) || [];
  const rawHanded = (result && result.handedness) || null;
  for (let i = 0; i < lms.length; i++) {
    const lm = lms[i];
    let hand = null;
    try {
      const h = rawHanded && rawHanded[i] && rawHanded[i][0];
      hand = (h && (h.categoryName || h.displayName)) || null;
    } catch { hand = null; }
    hands.push(hand ? { pts: lm, hand } : lm);
  }
  applyTracking(hands, nowMs, null);
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
function normalizeHandEntry(entry) {
  // Accepts legacy [21 {x,y}] arrays or new {pts, hand} objects.
  if (!entry) return null;
  if (Array.isArray(entry)) {
    if (entry.length < 21) return null;
    return { pts: entry, hand: null };
  }
  const pts = entry.pts || entry.landmarks || entry.lm || null;
  if (!pts || pts.length < 21) return null;
  return { pts, hand: entry.hand || entry.handedness || null };
}

function applyTracking(hands, nowMs, handedParallel) {
  // Build palm centroids (mirrored normalized coords). Preserves z +
  // handedness for P1 gestures; P2 stays centroid-only.
  const palms = [];
  for (let hi = 0; hi < (hands || []).length; hi++) {
    const norm = normalizeHandEntry(hands[hi]);
    if (!norm) continue;
    const lm = norm.pts;
    let hand = norm.hand;
    if (!hand && handedParallel && handedParallel[hi]) {
      try {
        const h = handedParallel[hi][0] || handedParallel[hi];
        hand = h.categoryName || h.displayName || null;
      } catch { hand = null; }
    }
    let sx = 0, sy = 0;
    for (const i of PALM_IDX) { sx += lm[i].x; sy += lm[i].y; }
    sx /= PALM_IDX.length; sy /= PALM_IDX.length;
    palms.push({ mx: 1 - sx, my: sy, lm, hand });       // mirror x like the preview
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
  slot.handedness = palm.hand || null;
  if (!slot.everDetected) slot.everDetected = true;
  // P1-only: refresh gesture snapshot as soon as landmarks land so power
  // (punch/fist) and direction (roll/facing) are never a frame stale.
  if (slot === state.hand && palm.lm) {
    try {
      slot.lastAnalyzedLm = palm.lm;
      slot.gesture = analyseP1Hand(palm.lm, slot.calib, slot.handedness);
    }
    catch { /* gesture must never break tracking */ }
  }
  setupReadyCheck();
  updateCalibrationTick();
}

/* ============================================================
   8. HAND INPUT → 3D PADDLES
   ============================================================ */

function isP1SlotForGestures(pl) {
  // Gestures are P1-only: near-rail paddle on this device, or the host's
  // P1 in LAN. P2/guest/AI stay centroid-only by design.
  if (isLan()) return pl === state.player;
  return pl === state.player;
}

function updateHandInput(dt) {
  if (isLan()) { lanHandInput(dt); return; }
  updateHandSlot(state.hand, state.player, handMapOpts(0), dt, true);
  if (twoPlayer()) updateHandSlot(state.hand2, state.p2, handMapOpts(1), dt, false);
}

// How a hand maps to a paddle, per mode:
//   · 2 Players (one shared camera): each player owns HALF of the
//     mirrored frame — their half stretches across the whole table so
//     nobody has to reach into the other player's camera space. P2's
//     axis also flips for their 180° view.
//   · VS-AI / LAN (one player per camera): full frame; the LAN guest
//     still flips because they watch the rotated POV.
function handMapOpts(idx) {
  if (state.mode === '2p') return { half: true, flip: idx === 1, pad: idx === 0 ? pad1Keys : pad2Keys };
  return { half: false, flip: false, pad: pad1Keys };
}

function lanHandInput(dt) {
  const flip = state.lan.role === 'p2';   // guest watches the rotated POV
  const mine = myPaddle();
  updateHandSlot(state.hand, mine, { half: false, flip, pad: pad1Keys }, dt, mine === state.player);
}

// P1-only table-tennis gesture (power + direction, no spin).
// Pure function of 21 unmirrored landmarks + calibration snapshot.
// Never throws for short/partial skeletons (returns neutral gesture).
function palmSizeOf(lm) {
  try {
    if (!lm || lm.length < 21) return 0;
    const dx = lm[9].x - lm[0].x, dy = lm[9].y - lm[0].y;
    return Math.hypot(dx, dy);
  } catch { return 0; }
}

function analyseP1Hand(lm, calib, handedness) {
  const neutral = { powerMul: 1, aimXTrim: 0, punch: 0, roll: 0, facing: 'unknown', fist: false };
  try {
    if (!lm || lm.length < 21) return neutral;
    const size = palmSizeOf(lm);
    if (!(size > 1e-6)) return neutral;
    // Grip: curled fingers (tips near PIPs) = fist = firmer hit.
    const pairs = [[8, 6], [12, 10], [16, 14], [20, 18]];
    let sum = 0, n = 0;
    for (const [tip, pip] of pairs) {
      if (!lm[tip] || !lm[pip]) continue;
      sum += Math.hypot(lm[tip].x - lm[pip].x, lm[tip].y - lm[pip].y) / size;
      n++;
    }
    const fist = n > 0 && (sum / n) < GRIP_FIST_RATIO;
    // Wrist roll in mirrored space (matches the on-screen paddle).
    const dxm = -((lm[9].x || 0) - (lm[0].x || 0));
    const dym = (lm[9].y || 0) - (lm[0].y || 0);
    const roll = clampNum(Math.atan2(dxm, -(dym || -1e-6)), -0.7, 0.7);
    // Forehand vs backhand: thumb side flips when the hand rotates.
    // Calibrated per user (mirrored): same side = forehand.
    let facing = 'unknown';
    try {
      const tmx = 1 - (lm[4].x || 0.5), ptx = 1 - (lm[20].x || 0.5);
      const side = Math.sign(tmx - ptx) || 0;
      const ref = (calib && calib.thumbSide) || 0;
      if (ref !== 0 && side !== 0) facing = side === ref ? 'forehand' : 'backhand';
      else if (handedness === 'Left' || handedness === 'Right') facing = 'forehand';
    } catch { facing = 'unknown'; }
    // Punch depth: hand growing vs neutral = moving toward the camera.
    let punch = 0;
    if (calib && calib.size > 1e-6) {
      punch = clampNum((size - calib.size) / calib.size, -0.4, 0.8);
    }
    const powerMul = clampNum(1 + Math.max(0, punch) * PUNCH_GAIN + (fist ? FIST_POWER_BONUS : 0), 0.8, 1.7);
    const aimXTrim = clampNum(roll * ROLL_GAIN + (facing === 'backhand' ? -0.05 : 0), -0.35, 0.35);
    return { powerMul, aimXTrim, punch, roll, facing, fist };
  } catch { return neutral; }
}

function updateHandSlot(hand, pl, opts, dt, isP1) {
  // Arm fallback: when the palm model drops the hand (fist, blur,
  // occlusion), the pose wrist keeps driving the same smoothing pipeline
  // — no coasting, no teleport. Single person per camera only (ai/lan);
  // 2p stays palm-only to avoid mixing two bodies.
  const allowArm = isP1 && !twoPlayer();
  const arm = (allowArm && !hand.detected) ? getFreshArm() : null;
  if (hand.detected || arm) {
    hand.lostMs = 0;
    hand.trackSrc = hand.detected ? 'palm' : 'arm';
    if (arm) {
      // Feed the wrist (palm-offset) through the identical path so the
      // paddle keeps its feel across palm↔arm handoffs.
      hand.rawX = arm.x;
      hand.rawY = arm.y;
      hand.assignX = arm.x;
      hand.assignY = arm.y;
    }

    // Speed-adaptive exponential smoothing (framerate independent):
    // a slow hand is filtered hard (steady aim); a fast swing barely at
    // all, so the paddle keeps up instead of lagging a beat behind.
    // Arm samples arrive at ~8fps, so cap the rate to avoid steppiness.
    const rawSpeed = dt > 0
      ? Math.hypot(hand.rawX - hand.prevRawX, hand.rawY - hand.prevRawY) / dt
      : 0;
    hand.motion += (rawSpeed - hand.motion) * Math.min(1, dt * 14);
    hand.prevRawX = hand.rawX;
    hand.prevRawY = hand.rawY;
    const rate = SMOOTH_SLOW + (SMOOTH_FAST - SMOOTH_SLOW) *
      clampNum(hand.motion / ADAPT_REF_SPEED, 0, 1);
    const effRate = arm ? Math.min(rate, 14) : rate;
    const a = 1 - Math.exp(-dt * effRate);
    hand.smX += (hand.rawX - hand.smX) * a;
    hand.smY += (hand.rawY - hand.smY) * a;

    // Map normalized hand position into the paddle workspace.
    let nx;
    if (opts.half) {
      // Stretch this player's half of the frame over the full table.
      const lo = opts.flip ? 0.5 : HAND_X_MIN;
      const hi = opts.flip ? HAND_X_MAX : 0.5;
      nx = (hand.smX - lo) / (hi - lo);
    } else {
      nx = (hand.smX - HAND_X_MIN) / (HAND_X_MAX - HAND_X_MIN);
    }
    const ny = (hand.smY - HAND_Y_MIN) / (HAND_Y_MAX - HAND_Y_MIN);
    const flip = opts.flip ? -1 : 1;
    pl.targetX = flip * Math.min(1.12, Math.max(-1.12, nx * 2 - 1)) * PADDLE_X_RANGE;
    pl.targetY = PADDLE_Y_TOP - Math.min(1, Math.max(0, ny)) * (PADDLE_Y_TOP - PADDLE_Y_BOT);
    // P1-only extras: wrist-roll aim trim + optional body-lean trim.
    // P2/guest/AI paths never touch gestures (centroid only).
    if (isP1) {
      try {
        if (hand.detected) {
          if (hand.landmarks && hand.landmarks !== hand.lastAnalyzedLm) {
            hand.lastAnalyzedLm = hand.landmarks;
            hand.gesture = analyseP1Hand(hand.landmarks, hand.calib, hand.handedness);
          }
        } else if (arm) {
          // No palm skeleton: aim from the forearm angle, power from the
          // swing itself. Never reuse a stale palm snapshot.
          const roll = armRoll();
          if (!hand.armGesture) {
            hand.armGesture = { powerMul: 1, punch: 0, fist: false, facing: 'unknown', roll: 0, aimXTrim: 0 };
          }
          hand.armGesture.roll = roll;
          hand.armGesture.aimXTrim = clampNum(roll * ARM_ROLL_GAIN, -0.35, 0.35);
          hand.gesture = hand.armGesture;
        }
        const g = hand.gesture;
        if (g && g.aimXTrim) pl.targetX = clampNum(pl.targetX + g.aimXTrim * PADDLE_X_RANGE * 0.5, -PADDLE_X_RANGE, PADDLE_X_RANGE);
        const lean = state.pose && state.pose.enabled && state.pose.ready ? state.pose.lean : 0;
        if (lean) pl.targetX = clampNum(pl.targetX + clampNum(lean * POSE_GAIN, -POSE_TRIM_MAX, POSE_TRIM_MAX), -PADDLE_X_RANGE, PADDLE_X_RANGE);
      } catch { /* gesture/pose must never break input */ }
    }
  } else {
    hand.trackSrc = 'none';
    hand.lostMs += dt * 1000;
    // Paddle coasts: targets stay where they were.
  }

  movePaddle(pl, opts.pad, dt, isP1 ? hand.gesture : null);
}

function updateKeyboardInput(dt) {
  if (isLan()) { drivePaddleKeyboard(myPaddle(), pad1Keys, dt); return; }
  drivePaddleKeyboard(state.player, pad1Keys, dt);
  if (twoPlayer()) drivePaddleKeyboard(state.p2, pad2Keys, dt);
}

function drivePaddleKeyboard(p, keysPad, dt) {
  const dx = (keysPad.right ? 1 : 0) - (keysPad.left ? 1 : 0);
  const dy = (keysPad.down ? 1 : 0) - (keysPad.up ? 1 : 0);
  // The far-rail paddle (P2 / LAN guest) watches a 180°-rotated view,
  // so their left/right keys flip in world x.
  const flip = !hasBot() && p === state.p2 ? -1 : 1;
  p.targetX = p.x + flip * dx * KEY_SPEED * dt;
  p.targetY = p.y - dy * KEY_SPEED * dt;
  movePaddle(p, keysPad, dt);
}

function movePaddle(p, keysPad, dt, gesture) {
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
  // P1 punch depth stretches the lunge slightly (still visual-only;
  // hit reach bonus lives in stepPlayerHit).
  const rail = p.railZ !== undefined ? p.railZ : PADDLE_Z;
  let lunge = Math.min(0.18, p.speed * 0.045);
  try {
    if (gesture && gesture.punch > 0) lunge = Math.min(0.24, lunge + gesture.punch * 0.08);
  } catch { /* ignore */ }
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
        : (twoPlayer() ? '✋ Show your hand to the camera'
          : '✋ Show your hand or arm to the camera');
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

function makeStatic(obj) {
  obj.matrixAutoUpdate = false;
  obj.updateMatrix();
}

let contextLost = false;   // toggled by WebGL context-loss/restore handlers

function initThree() {
  world.renderer = new THREE.WebGLRenderer({
    canvas: el.game,
    // MSAA is wasted once devicePixelRatio ≥ 2 (supersampling already smooths
    // edges) — exactly the phones most likely to be GPU-bound.
    antialias: window.devicePixelRatio < 2,
    powerPreference: 'high-performance',
  });
  world.renderer.shadowMap.enabled = true;
  world.renderer.shadowMap.type = THREE.PCFShadowMap;
  world.renderer.shadowMap.autoUpdate = false;
  world.renderer.toneMapping = THREE.ReinhardToneMapping;
  world.renderer.toneMappingExposure = 1.12;

  // WebGL context loss (GPU reset / driver crash / laptop sleep-resume) would
  // otherwise black-screen the canvas permanently with no recovery path.
  // Pause the render loop on loss and rebuild renderer sizing on restore so
  // play resumes instead of dying.
  const glCanvas = world.renderer.domElement;
  glCanvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();            // required so the context can be restored
    contextLost = true;
    try { toast('Graphics reset — restoring…'); } catch { /* ignore */ }
  }, false);
  glCanvas.addEventListener('webglcontextrestored', () => {
    try {
      layout();                    // re-applies size / DPR / FOV
      world.renderer.shadowMap.needsUpdate = true;
      world.renderer.shadowMap.autoUpdate = false;
      contextLost = false;
      toast('Graphics restored');
    } catch { /* ignore */ }
  }, false);

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
  makeStatic(floor);
  scene.add(floor);

  // Subtle floor grid
  const grid = new THREE.GridHelper(22, 44, 0x1c2a4a, 0x111a30);
  grid.position.y = 0.005;
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  makeStatic(grid);
  scene.add(grid);

  // Glow ring around the table
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.15, 2.32, 64),
    new THREE.MeshBasicMaterial({ color: 0x4dd7ff, transparent: true, opacity: 0.28, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.012;
  makeStatic(ring);
  scene.add(ring);

  // Back wall + neon strips
  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 6),
    new THREE.MeshStandardMaterial({ color: 0x0d1426, roughness: 1 })
  );
  wall.position.set(0, 3, -7);
  makeStatic(wall);
  scene.add(wall);

  const stripGeo = new THREE.BoxGeometry(9, 0.07, 0.05);
  const stripCyan = new THREE.Mesh(stripGeo, new THREE.MeshBasicMaterial({ color: 0x4dd7ff }));
  stripCyan.position.set(-4.5, 2.6, -6.95);
  makeStatic(stripCyan);
  scene.add(stripCyan);
  const stripPink = new THREE.Mesh(stripGeo, new THREE.MeshBasicMaterial({ color: 0xff5d73 }));
  stripPink.position.set(4.5, 2.2, -6.95);
  makeStatic(stripPink);
  scene.add(stripPink);
  const stripGreen = new THREE.Mesh(new THREE.BoxGeometry(5, 0.05, 0.05), new THREE.MeshBasicMaterial({ color: 0x35e08c }));
  stripGreen.position.set(0, 3.6, -6.95);
  makeStatic(stripGreen);
  scene.add(stripGreen);

  // Mirror wall + strips behind P1's camera (they fill P2's split-screen
  // POV, which looks the opposite way up the arena).
  const wall2 = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 6),
    new THREE.MeshStandardMaterial({ color: 0x0d1426, roughness: 1 })
  );
  wall2.position.set(0, 3, 7);
  wall2.rotation.y = Math.PI;
  makeStatic(wall2);
  scene.add(wall2);
  const stripCyan2 = new THREE.Mesh(stripGeo, stripCyan.material);
  stripCyan2.position.set(4.5, 2.6, 6.95);
  makeStatic(stripCyan2);
  scene.add(stripCyan2);
  const stripPink2 = new THREE.Mesh(stripGeo, stripPink.material);
  stripPink2.position.set(-4.5, 2.2, 6.95);
  makeStatic(stripPink2);
  scene.add(stripPink2);
  const stripGreen2 = new THREE.Mesh(stripGreen.geometry, stripGreen.material);
  stripGreen2.position.set(0, 3.6, 6.95);
  makeStatic(stripGreen2);
  scene.add(stripGreen2);

  // Side barrier boards (like real TT surrounds)
  const boardMat = new THREE.MeshStandardMaterial({ color: 0x101a30, roughness: 0.9 });
  for (const side of [-1, 1]) {
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.55, 5.2), boardMat);
    board.position.set(side * 2.6, 0.275, 0);
    makeStatic(board);
    scene.add(board);
  }
  const farBoard = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.55, 0.04), boardMat);
  farBoard.position.set(0, 0.275, -3.1);
  makeStatic(farBoard);
  scene.add(farBoard);

  // Lights
  scene.add(new THREE.HemisphereLight(0x8fb4ff, 0x1a1420, 0.85));

  const key = new THREE.DirectionalLight(0xfff2dd, 1.7);
  key.position.set(2.5, 5.5, 3.5);
  key.castShadow = true;
  key.shadow.mapSize.set(512, 512);
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
  makeStatic(top);
  group.add(top);

  // White boundary lines (edges of the surface)
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(TABLE.W, 0.001, TABLE.L)),
    new THREE.LineBasicMaterial({ color: 0xeef3ff })
  );
  edges.position.y = TABLE.H + 0.002;
  makeStatic(edges);
  group.add(edges);

  // Center line (lengthwise)
  const centerLine = new THREE.Mesh(
    new THREE.BoxGeometry(0.012, 0.002, TABLE.L),
    new THREE.MeshBasicMaterial({ color: 0xeef3ff })
  );
  centerLine.position.y = TABLE.H + 0.002;
  makeStatic(centerLine);
  group.add(centerLine);

  // Apron under the surface
  const apron = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.W - 0.08, 0.09, TABLE.L - 0.12),
    new THREE.MeshStandardMaterial({ color: 0x0e1526, roughness: 0.8 })
  );
  apron.position.y = TABLE.H - 0.085;
  makeStatic(apron);
  group.add(apron);

  // Legs
  const legMat = new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.5, metalness: 0.6 });
  const legGeo = new THREE.BoxGeometry(0.06, TABLE.H - 0.06, 0.06);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = new THREE.Mesh(legGeo, legMat);
    leg.position.set(sx * 0.62, (TABLE.H - 0.06) / 2, sz * 1.1);
    leg.castShadow = true;
    makeStatic(leg);
    group.add(leg);
  }

  // Net assembly
  const net = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.NET_W, TABLE.NET_H - 0.012, 0.008),
    new THREE.MeshStandardMaterial({ color: 0x9aa7c0, transparent: true, opacity: 0.75, roughness: 0.9 })
  );
  net.position.set(0, TABLE.H + (TABLE.NET_H - 0.012) / 2, 0);
  makeStatic(net);
  group.add(net);

  const netTop = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.NET_W, 0.012, 0.01),
    new THREE.MeshBasicMaterial({ color: 0xeef3ff })
  );
  netTop.position.set(0, NET_TOP - 0.006, 0);
  makeStatic(netTop);
  group.add(netTop);

  const postMat = new THREE.MeshStandardMaterial({ color: 0x2a3040, roughness: 0.4, metalness: 0.7 });
  const postGeo = new THREE.CylinderGeometry(0.012, 0.012, TABLE.NET_H + 0.02, 10);
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(sx * (TABLE.NET_W / 2), TABLE.H + TABLE.NET_H / 2, 0);
    makeStatic(post);
    group.add(post);
  }

  makeStatic(group);
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
  state.slowMo = 1;          // bullet-time window closed
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
  if (world.opponent) world.opponent.visible = hasBot();
}

function startMatch() {
  resetMatch();
  syncOpponentVisibility();
  syncScoreLabels();
  showScreen('play');
  state.phase = 'countdown';
  state.timer = COUNTDOWN_STEP * 3;
  state.lastCountdown = -1;
  // LAN: whichever device starts (or restarts) drags its peer along.
  if (isLan() && !lanApplyingRemote && state.lan.role) lanSend({ t: 'start' });
}

function syncScoreLabels() {
  if (!el['score-label-you']) return;
  el['score-label-you'].textContent = hasBot() ? 'YOU' : 'P1';
  el['score-label-ai'].textContent = hasBot() ? 'AI' : 'P2';
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
    showBanner(hasBot() ? 'Your serve' : "Player 1's serve", 'Swipe through the ball to launch it');
  } else {
    showBanner(hasBot() ? 'AI serve' : "Player 2's serve",
      hasBot() ? 'Get ready…' : 'Swipe through the ball to launch it');
  }
}

function beginServe() {
  state.phase = 'serve';
  state.serveTimer = 0;
  state.rally = 0;
  state.slowMo = 1;               // ball-time resets with the point
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
  return hasBot() ? state.ai : state.p2;
}

// Unified serve launch for all three cases (P1 / P2 / AI).
// P1 serves pick up gesture power + roll trim; P2/AI unchanged.
function launchServe() {
  const b = state.ball;
  const sp = serverPaddle();
  const aiControlled = state.serveSide === 'ai' && hasBot();
  const cfg = DIFFICULTY[state.difficulty];

  const isP1Serve = !aiControlled && sp === state.player;
  const gServe = isP1Serve ? p1Gesture() : null;
  const power = aiControlled
    ? cfg.returnSpeed - 0.3
    : Math.min(isP1Serve ? 3.8 : 3.5, (2.2 + sp.speed * 0.35) * (gServe ? gServe.powerMul : 1));
  const aimX = aiControlled
    ? clampNum((Math.random() - 0.5) * 1.0, -0.62, 0.62)
    : clampNum(sp.vx * 0.14 + (gServe ? gServe.aimXTrim : 0) + (Math.random() - 0.5) * 0.35, -0.66, 0.66);
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
    showBanner(hasBot() ? 'Your point!' : 'Point Player 1!', `${state.scoreYou} : ${state.scoreAI}`, 'you');
    blip(660, 0.09, 'sine', 0.07);
    setTimeout(() => blip(880, 0.12, 'sine', 0.07), 90);
  } else {
    showBanner(hasBot() ? 'AI point' : 'Point Player 2!', `${state.scoreYou} : ${state.scoreAI}`, 'ai');
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
  // Wins/losses are a "you vs AI" record — human-vs-human matches don't touch them.
  if (hasBot()) {
    if (winner === 'you') state.stats.wins++; else state.stats.losses++;
    saveGame();
  }

  const you = state.scoreYou, ai = state.scoreAI;
  const humanVHuman = !hasBot();
  el['gameover-emoji'].textContent = (winner === 'you' || humanVHuman) ? '🏆' : '🤖';
  el['gameover-title'].textContent = humanVHuman
    ? `${sideLabel(winner)} wins!`
    : (winner === 'you' ? 'You win!' : 'AI wins');
  el['gameover-title'].className = winner === 'you' ? 'win' : 'lose';
  el['gameover-score'].textContent = `${you} : ${ai}`;
  el['gameover-rally'].textContent = state.longestRally;
  el['gameover-diff'].textContent = state.mode === '2p' ? '2 Players'
    : state.mode === 'lan' ? 'LAN 2P'
      : DIFFICULTY[state.difficulty].label;
  hideBanner();
  showScreen('play');   // reveals the game-over overlay
  // LAN: the guest rebuilds this overlay from the event (sounds arrive
  // separately via the blip relay).
  lanEmit({
    k: 'over',
    emoji: el['gameover-emoji'].textContent,
    title: el['gameover-title'].textContent,
    cls: el['gameover-title'].className,
    score: el['gameover-score'].textContent,
    rally: state.longestRally,
    diffLabel: el['gameover-diff'].textContent,
  });

  // Both sides are human in 2p/LAN — always celebrate.
  const celebrate = winner === 'you' || humanVHuman;
  if (celebrate) {
    spawnConfetti();
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => blip(f, 0.16, 'triangle', 0.07), i * 130));
  } else {
    [392, 330, 262].forEach((f, i) => setTimeout(() => blip(f, 0.18, 'sine', 0.06), i * 160));
  }
}

function updateServeChip() {
  el['serve-chip'].textContent = state.serveSide === 'you'
    ? (hasBot() ? 'Your serve' : 'P1 serve')
    : (hasBot() ? 'AI serve' : 'P2 serve');
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

// Real ball-time target for this frame (1 = full speed).
// A slow-motion window opens only when the ball is incoming toward a
// HUMAN receiver's strike zone:
//   · VS-AI: lastHitter 'ai' + vz > 0 → incoming for P1's near rail.
//   · 2P/LAN: the far rail is human too — lastHitter 'you' + vz < 0 also
//     opens a window, so P2 gets identical help (host-authoritative sim).
// The bot never gets a window: it never needs one to be beatable, so
// VS-AI balance only ever shifts toward the player. Inside the zone the
// factor eases quartically from 1 (at the net) down to SLOWMO_SCALE at
// the rail — time drops fast on entry and holds deep while the ball
// glides the last stretch to the paddle.
function slowMoTarget() {
  const b = state.ball;
  let railZ = null;
  if (state.phase !== 'rally' || !b.visible) return 1;
  if (b.lastHitter === 'ai' && b.vz > 0) railZ = state.player.railZ;                // incoming for P1
  else if (b.lastHitter === 'you' && b.vz < 0 && !hasBot()) railZ = state.p2.railZ; // human far rail
  if (railZ == null) return 1;
  const zoneLen = Math.abs(railZ) - SLOWMO_ZONE_Z;   // net edge → rail
  const f = clampNum(Math.abs(railZ - b.z) / zoneLen, 0, 1);   // 1 at entry → 0 at rail
  return SLOWMO_SCALE + (1 - SLOWMO_SCALE) * f * f * f * f;
}

// Per-frame: ease ball-time toward the target scale with real dt (hand
// input, camera, timers and the AI all keep full frame rate — only the
// ball glides). Fires a soft one-shot sweep when a window first opens.
function updateSlowMo(dt) {
  const target = slowMoTarget();
  const k = 1 - Math.exp(-dt * SLOWMO_RATE);
  const was = state.slowMo;
  state.slowMo += (target - state.slowMo) * k;
  // Soft descending sweep as the window opens (≤1 per approach; the
  // 0.75 threshold stops repeat firing while it eases through).
  if (was > 0.75 && state.slowMo < 0.75 && target < 0.75) {
    blip(520, 0.1, 'sine', 0.02, 120);
  }
}

function stepBall(dt, scoring) {
  const b = state.ball;
  if (!b.visible) return;

  const speed = Math.hypot(b.vx, b.vy, b.vz);
  const steps = Math.min(4, Math.max(1, Math.ceil(speed * dt / (BALL_R * 0.8))));
  const sdt = dt / steps;
  const gs = GRAVITY * sdt;

  for (let i = 0; i < steps; i++) {
    const prevZ = b.z;

    b.vy -= gs;
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
        blip(110, 0.08, 'sawtooth', 0.04, BLIP_AMBIENT_GAP);
      }
    }

    // --- Table bounce ---
    if (b.vy < 0 && b.y <= TABLE.H + BALL_R && b.y > TABLE.H - 0.12 &&
        Math.abs(b.x) <= HALF_W && Math.abs(b.z) <= HALF_L) {
      b.y = TABLE.H + BALL_R;
      b.vy = -b.vy * RESTITUTION;
      b.vx *= 0.96;
      b.vz *= 0.96;
      blip(175, 0.045, 'sine', 0.055, BLIP_AMBIENT_GAP);

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
        blip(120, 0.04, 'sine', 0.03, BLIP_AMBIENT_GAP);
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

// The human-controlled paddles: P1 always; P2 (far rail) joins when the
// far side is a human — two-player on one device, or the LAN guest.
// Paddle identities never change (fields mutate, objects don't), so these
// arrays are safe to cache — stepPlayerHit runs twice per rally frame and
// used to allocate throwaway arrays on the hottest path.
const NEAR_PADDLES_BOT = [state.player];
const NEAR_PADDLES_HUMAN = [state.player, state.p2];

function nearSidePaddles() {
  return hasBot() ? NEAR_PADDLES_BOT : NEAR_PADDLES_HUMAN;
}

function p1Gesture() {
  // P1-only gesture snapshot (power + direction). P2/guest return neutral
  // so their game feel is byte-for-byte the old centroid path.
  try {
    const g = state.hand && state.hand.gesture;
    if (g && typeof g.powerMul === 'number') return g;
  } catch { /* ignore */ }
  return { powerMul: 1, aimXTrim: 0, punch: 0, roll: 0, facing: 'unknown', fist: false };
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
    // P1 punch stretches reach slightly; P2 keeps the base radius.
    let reach = PADDLE_REACH;
    if (pl === state.player) {
      try {
        const punch = p1Gesture().punch;
        if (punch > 0) reach += Math.min(PUNCH_REACH_BONUS, punch * 0.08);
      } catch { /* ignore */ }
    }
    if (dist > reach) continue;
    playerReturn(pl);
    break;                                             // one contact per step
  }
}

function playerReturn(pl) {
  const b = state.ball;

  // Contact! Aim the return using swing direction + a little randomness.
  // P1 adds gesture power (punch/fist) + wrist-roll direction trim.
  const isP1 = pl === state.player;
  const g = isP1 ? p1Gesture() : null;
  const swing = Math.min(4, pl.speed);
  const powerMul = g ? g.powerMul : 1;
  const speed = clampNum((2.3 + state.rally * 0.08 + swing * 0.45) * powerMul, 2.3, 6.8);
  const aimTrim = g ? g.aimXTrim : 0;
  const aimX = clampNum(pl.vx * 0.16 + aimTrim + (Math.random() - 0.5) * 0.3, -0.72, 0.72);
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
  if (hasBot()) {
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
  if (!hasBot()) return;                 // no bot when the far side is human
  const cfg = DIFFICULTY[state.difficulty];
  const ai = state.ai;
  const b = state.ball;

  ai.hitCooldown = Math.max(0, ai.hitCooldown - dt);
  ai.reactT = Math.max(0, ai.reactT - dt);

  const incoming = state.phase === 'rally' && b.lastHitter === 'you' && b.vz < 0 && b.visible;

  if (incoming && ai.reactT <= 0) {
    const stamp = b.lastHitter + '|' + b.bounces + '|' + state.rally;
    const nowMs = performance.now();
    if (stamp !== ai.predStamp || nowMs - ai.predAt > 120) {
      ai.predStamp = stamp; ai.predAt = nowMs;
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
// Ball trail as a preallocated ring — the old push/shift allocated an
// object every rally frame (minor GC churn on the hottest path).
const TRAIL_N = 10;
const trailPts = [];
for (let i = 0; i < TRAIL_N; i++) trailPts.push({ x: 0, y: 0, z: 0 });
let trailHead = 0;    // next slot to overwrite (oldest entry)
let trailCount = 0;   // valid entries (<= TRAIL_N)

function trailPush(x, y, z) {
  const pt = trailPts[trailHead];
  pt.x = x; pt.y = y; pt.z = z;
  trailHead = (trailHead + 1) % TRAIL_N;
  if (trailCount < TRAIL_N) trailCount++;
}

function trailClear() { trailHead = 0; trailCount = 0; }

function trailNewest(i) {   // i = 0 → newest point, null when empty
  if (i >= trailCount) return null;
  return trailPts[(trailHead - 1 - i + TRAIL_N * 2) % TRAIL_N];
}

function renderScene(dt) {
  const p = state.player;
  const b = state.ball;

  // Player paddles follow the smoothed targets; tilt with the swing.
  // P1 also tilts with wrist roll (Kinect-style visual feedback).
  const pp = world.playerPaddle;
  pp.position.set(p.x, p.y, p.z);
  let p1Roll = 0;
  try { p1Roll = (state.hand && state.hand.gesture && state.hand.gesture.roll) || 0; } catch { p1Roll = 0; }
  pp.rotation.z = clampNum(-p.vx * 0.05 + p1Roll * 0.45, -0.6, 0.6);
  pp.rotation.x = 0.12 + clampNum(p.vy * 0.04, -0.35, 0.35);

  if (world.p2Paddle) {
    world.p2Paddle.visible = !hasBot();   // P2's paddle in 2p and LAN
    if (!hasBot()) {
      const q = state.p2;
      world.p2Paddle.position.set(q.x, q.y, q.z);
      world.p2Paddle.rotation.z = clampNum(-q.vx * 0.05, -0.5, 0.5);
      world.p2Paddle.rotation.x = 0.12 + clampNum(q.vy * 0.04, -0.35, 0.35);
    }
  }

  // AI paddle (single-player only).
  const ap = world.aiPaddle;
  ap.visible = hasBot();
  if (hasBot()) {
    ap.position.set(state.ai.x, state.ai.y, state.ai.z);
    ap.rotation.z = clampNum(state.ai.vx * 0.04, -0.4, 0.4);
  }

  // Opponent leans toward the ball.
  if (world.opponent && world.opponent.visible) {
    world.opponent.position.x += (clampNum(b.x * 0.3, -0.7, 0.7) - world.opponent.position.x) * Math.min(1, dt * 4);
    world.opponent.position.y = Math.sin(performance.now() * 0.0016) * 0.02;
  }

  // Ball + shadow + trail. During the bullet-time window the ball glows
  // softly and its spin eases with ball-time — a clear "line up now" cue.
  const sm = clampNum((1 - state.slowMo) / (1 - SLOWMO_SCALE), 0, 1);   // 0..1 window depth
  world.ball.visible = b.visible;
  world.ball.position.set(b.x, b.y, b.z);
  world.ball.rotation.x += dt * 6 * state.slowMo;
  try { world.ball.material.emissiveIntensity = 0.35 + sm * 0.9; }
  catch { /* material tweak must never break rendering */ }

  const overTable = Math.abs(b.x) <= HALF_W + 0.2 && Math.abs(b.z) <= HALF_L + 0.2 && b.y > TABLE.H;
  const shadowY = overTable ? TABLE.H + 0.004 : 0.006;
  const h = Math.max(0.05, b.y - shadowY);
  world.ballShadow.visible = b.visible;
  world.ballShadow.position.set(b.x, shadowY, b.z);
  const sScale = clampNum(1.6 - h * 0.55, 0.4, 1.6);
  world.ballShadow.scale.set(sScale, sScale, sScale);
  world.ballShadow.material.opacity = clampNum(0.42 - h * 0.16, 0.06, 0.42);

  if (b.visible && state.phase === 'rally') {
    trailPush(b.x, b.y, b.z);
  } else if (trailCount) {
    trailClear();
  }
  for (let i = 0; i < world.trail.length; i++) {
    const t = world.trail[i];
    const pt = trailNewest(i);
    if (pt) { t.visible = true; t.position.set(pt.x, pt.y, pt.z); }
    else t.visible = false;
  }

  // Camera sway follows each player's own paddle, then draw.
  // Two-player (one device): split screen — left half is P1's POV from
  // the near end, right half is P2's POV from the far end (180° around).
  // LAN: each device renders ONE full-screen POV — its own.
  const r = world.renderer;
  if (r.shadowMap.enabled && !state.paused) {
    // Update shadows at 30Hz max to reduce GPU load
    state.perf.frameCount++;
    if (state.perf.frameCount % 2 === 0) r.shadowMap.needsUpdate = true;
  }
  const fullAspect = view.w / view.h;
  if (isLan() && world.camera2) {
    const guest = state.lan.role === 'p2';
    const cam = guest ? world.camera2 : world.camera;
    const mine = myPaddle();
    cam.position.x += (mine.x * 0.09 - cam.position.x) * Math.min(1, dt * 5);
    cam.lookAt(0, 0.78, guest ? 0.55 : -0.55);
    if (cam.aspect !== fullAspect) { cam.aspect = fullAspect; cam.updateProjectionMatrix(); }
    r.setViewport(0, 0, view.w, view.h);
    r.render(world.scene, cam);
  } else if (twoPlayer() && world.camera2) {
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
    if (world.camera.aspect !== fullAspect) { world.camera.aspect = fullAspect; world.camera.updateProjectionMatrix(); }
    world.camera.position.x += (p.x * 0.09 - world.camera.position.x) * Math.min(1, dt * 5);
    world.camera.lookAt(0, 0.78, -0.55);
    r.setViewport(0, 0, view.w, view.h);
    r.render(world.scene, world.camera);
  }
}

// Picture-in-picture camera preview with hand skeletons.
// Redrawn at most ~30fps on setup, ~8fps during play — the 3D view is
// the star; the PiP is a mirror.
let lastPreviewDraw = 0;

function drawSkeletonSlot(pc, slot, cx0, cw, W, H, color) {
  const lm = slot.landmarks;
  if (!lm) return;
  pc.save();
  pc.beginPath();
  pc.rect(cx0, 0, cw, H);
  pc.clip();
  pc.strokeStyle = color;
  pc.lineWidth = 2;
  pc.lineCap = 'round';
  pc.beginPath();
  for (let i = 0; i < HAND_CONNECTIONS.length; i++) {
    const a = HAND_CONNECTIONS[i][0], bIdx = HAND_CONNECTIONS[i][1];
    pc.moveTo((1 - lm[a].x) * W, lm[a].y * H);
    pc.lineTo((1 - lm[bIdx].x) * W, lm[bIdx].y * H);
  }
  pc.stroke();
  pc.fillStyle = color;
  pc.beginPath();
  for (let i = 0; i < lm.length; i++) {
    const pt = lm[i];
    const px = (1 - pt.x) * W, py = pt.y * H;
    pc.moveTo(px + 3, py);
    pc.arc(px, py, 3, 0, Math.PI * 2);
  }
  pc.fill();
  pc.restore();
}

function drawPreview() {
  const nowMs = performance.now();
  // The in-play PiP is a tiny corner mirror: redraw it far less often than
  // the setup calibration view. A full-res video drawImage every 33ms
  // contends with WebGL on the same GPU process — a classic hitch source.
  const interval = state.screen === 'setup' ? PREVIEW_INTERVAL_MS : PREVIEW_PLAY_MS;
  if (nowMs - lastPreviewDraw < interval) return;
  lastPreviewDraw = nowMs;

  const pc = previewCtx;
  const W = el.preview.width, H = el.preview.height;
  pc.fillStyle = '#05070d';
  pc.fillRect(0, 0, W, H);

  const feed = TEST_MODE ? state.fakeBackground : null;
  const liveVideo = !TEST_MODE && video && video.readyState >= 2 && video.videoWidth ? video : null;

  // Two-player on one device: the preview splits down the middle — left
  // half is P1's region of the (mirrored) feed, right half is P2's.
  // LAN devices show their own single hand full-size.
  const split = state.mode === '2p';

  if (feed || liveVideo) {
    const src = feed || liveVideo;
    const sw = feed ? feed.width : liveVideo.videoWidth;
    const sh = feed ? feed.height : liveVideo.videoHeight;
    const s = Math.max(W / sw, H / sh);

    pc.save();
    pc.translate(W, 0);
    pc.scale(-1, 1);                       // mirrored, like a mirror
    pc.drawImage(src, (W - sw * s) / 2, (H - sh * s) / 2, sw * s, sh * s);
    pc.restore();

    // Skeletons — in split mode each half shows only its own player.
    // (Drawn via a helper: no per-draw array allocations on this path.)
    if (split) {
      drawSkeletonSlot(pc, state.hand, 0, W / 2, W, H, 'rgba(77, 215, 255, 0.85)');
      drawSkeletonSlot(pc, state.hand2, W / 2, W - W / 2, W, H, 'rgba(255, 141, 77, 0.9)');
    } else {
      drawSkeletonSlot(pc, state.hand, 0, W, W, H, 'rgba(77, 215, 255, 0.85)');
      drawSkeletonSlot(pc, state.hand2, 0, W, W, H, 'rgba(255, 141, 77, 0.9)');
    }

    // Arm overlay (P1 wrist→elbow→shoulder): shows even when the palm
    // skeleton is gone, so players see what is actually driving them.
    // Skipped in split 2P — arm fusion is single-camera only.
    if (!split) {
      try {
        const pts = state.pose && state.pose.armPts;
        const fresh = getFreshArm();
        if (pts && fresh && pts.wx != null) {
          const X = (x) => (1 - x) * W, Y = (y) => y * H;
          pc.save();
          pc.strokeStyle = 'rgba(77, 215, 255, 0.9)';
          pc.lineWidth = 3;
          pc.lineCap = 'round';
          pc.beginPath();
          let started = false;
          const seg = [];
          if (pts.sx != null) seg.push([pts.sx, pts.sy]);
          if (pts.ex != null) seg.push([pts.ex, pts.ey]);
          seg.push([pts.wx, pts.wy]);
          for (const [jx, jy] of seg) {
            if (!started) { pc.moveTo(X(jx), Y(jy)); started = true; }
            else pc.lineTo(X(jx), Y(jy));
          }
          pc.stroke();
          pc.fillStyle = 'rgba(77, 215, 255, 0.95)';
          for (const [jx, jy] of seg) {
            pc.beginPath();
            pc.arc(X(jx), Y(jy), 4, 0, Math.PI * 2);
            pc.fill();
          }
          pc.restore();
        }
      } catch { /* overlay must never break preview */ }
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
    } else {
      // Tracking-source tag: PALM (precise) vs ARM (wrist fallback).
      try {
        const src = state.hand && state.hand.trackSrc;
        if (src === 'arm' && state.screen === 'play') {
          pc.font = '700 11px Inter, sans-serif';
          pc.textAlign = 'right';
          pc.fillStyle = 'rgba(77, 215, 255, 0.9)';
          pc.fillText('ARM TRACKING', W - 8, 17);
        }
      } catch { /* ignore */ }
    }
    // P1-only gesture readout: forehand/backhand + power bar. Cheap canvas
    // text, no DOM churn; P2 side stays clean by design.
    try {
      const g = state.hand && state.hand.gesture;
      if (g && (g.facing !== 'unknown' || g.powerMul !== 1 || g.fist)) {
        const label = (g.facing === 'unknown' ? '' : g.facing.toUpperCase() + ' ') + (g.fist ? 'FIST' : 'OPEN');
        pc.font = '700 11px Inter, sans-serif';
        pc.textAlign = 'left';
        pc.fillStyle = 'rgba(53, 224, 140, 0.95)';
        pc.fillText(label.trim(), 8, H - 10);
        const pw = Math.min(1, Math.max(0, (g.powerMul - 0.8) / 0.9));
        pc.fillStyle = 'rgba(53, 224, 140, 0.35)';
        pc.fillRect(8, H - 7, 64, 3);
        pc.fillStyle = 'rgba(53, 224, 140, 0.95)';
        pc.fillRect(8, H - 7, 64 * pw, 3);
      }
      if (state.pose && state.pose.enabled && state.pose.ready && Math.abs(state.pose.lean) > 0.02) {
        pc.font = '700 11px Inter, sans-serif';
        pc.textAlign = 'right';
        pc.fillStyle = 'rgba(77, 215, 255, 0.9)';
        pc.fillText(state.pose.lean > 0 ? 'LEAN →' : '← LEAN', W - 8, H - 10);
      }
    } catch { /* overlay must never break preview */ }
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
  lanEmit({ k: 'banner', text, sub: sub || '', tone: tone || '' });
}

function hideBanner() {
  el.banner.classList.add('hidden');
  if (bannerTimeout) { clearTimeout(bannerTimeout); bannerTimeout = null; }
  lanEmit({ k: 'hide' });
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
const BLIP_AMBIENT_GAP = 50;               // min ms between physics-noise blips (node churn)

// Sound node pooling to reduce GC pressure
const SOUND_POOL_SIZE = 8;
let soundPool = [];
let poolIndex = 0;

function ensureAudio() {
  if (!state.sound) return null;
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // Continuous-voice pool: oscillators run forever at zero gain;
      // playTone only shapes the gain envelope — never start()/stop().
      soundPool = [];
      for (let i = 0; i < SOUND_POOL_SIZE; i++) {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        g.gain.value = 0;
        o.connect(g); g.connect(audioCtx.destination);
        o.start();
        soundPool.push({ osc: o, gain: g });
      }
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  } catch { return null; }
}

let lastAmbientBlipMs = -1e9;

function blip(freq, dur = 0.06, type = 'sine', gain = 0.05, minGap = 0) {
  try {
    // Ambient physics noises (net/table/floor) can cluster within adjacent
    // frames — each one builds AudioContext nodes, so collapse clusters
    // into a single blip. Hits, serves and point jingles pass minGap = 0
    // and always play. The LAN relay skips with the blip (guest replays
    // host sounds, so both sides stay in sync).
    if (minGap > 0) {
      const now = performance.now();
      if (now - lastAmbientBlipMs < minGap) return;
      lastAmbientBlipMs = now;
    }
    lanEmit({ k: 'blip', f: freq, d: dur, ty: type, g: gain });   // LAN guest replays host sounds
    playTone(freq, dur, type, gain);
  } catch { /* sound must never break gameplay */ }
}

function playTone(freq, dur, type, gain) {
  const ac = ensureAudio();
  if (!ac || !soundPool.length) return;
  const v = soundPool[poolIndex];
  poolIndex = (poolIndex + 1) % SOUND_POOL_SIZE;
  try {
    const t = ac.currentTime;
    v.osc.type = type;
    v.osc.frequency.setValueAtTime(freq, t);
    const g = v.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(0.0001, gain), t);
    g.exponentialRampToValueAtTime(0.0001, t + Math.max(0.01, dur));
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

const MAX_CONFETTI = 150;
const CONFETTI_COLORS = ['#35e08c', '#4dd7ff', '#ffd166', '#ff5d73', '#eef3ff'];
const confettiParts = [];
for (let i = 0; i < MAX_CONFETTI; i++) {
  confettiParts.push({ x: 0, y: 0, vx: 0, vy: 0, w: 0, h: 0, rot: 0, vr: 0, color: '#000000' });
}
let confettiUntil = 0;
let confettiActive = false;

function spawnConfetti() {
  if (REDUCED_MOTION) return;
  for (let i = 0; i < MAX_CONFETTI; i++) {
    const p = confettiParts[i];
    p.x = view.w / 2 + (Math.random() - 0.5) * view.w * 0.5;
    p.y = view.h * 0.25 + (Math.random() - 0.5) * 60;
    p.vx = (Math.random() - 0.5) * 420;
    p.vy = -Math.random() * 380 - 60;
    p.w = 5 + Math.random() * 6;
    p.h = 8 + Math.random() * 8;
    p.rot = Math.random() * Math.PI;
    p.vr = (Math.random() - 0.5) * 10;
    p.color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
  }
  confettiUntil = performance.now() + 2800;
  confettiActive = true;
}

function stepConfetti(dt) {
  if (!confettiActive) return;
  const cc = confettiCtx, d = view.dpr;
  cc.setTransform(d, 0, 0, d, 0, 0);
  cc.clearRect(0, 0, view.w, view.h);
  if (performance.now() > confettiUntil) { confettiActive = false; return; }
  for (let i = 0; i < MAX_CONFETTI; i++) {
    const p = confettiParts[i];
    p.vy += 900 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
    const c = Math.cos(p.rot) * d, s = Math.sin(p.rot) * d;
    cc.setTransform(c, s, -s, c, p.x * d, p.y * d);
    cc.fillStyle = p.color;
    cc.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
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
  // LAN: keep both devices' pause state in sync (host stays authoritative).
  if (isLan()) lanSend({ t: 'pause', v: next });
  if (state.paused) {
    hideBanner();
    blip(300, 0.06, 'sine', 0.04);
  } else {
    if (state.phase === 'serve') showServeBanner();
    blip(500, 0.06, 'sine', 0.04);
  }
}

// Set on the guest while applying a host-initiated action, so the
// relayed broadcast doesn't echo back over the wire.
let lanApplyingRemote = false;

function startKeyboardMode() {
  state.inputMode = 'keyboard';
  if (!state.pose.enabled) stopPoseWorker();   // no arm fallback needed on keys
  if (isLan()) {
    toast('LAN keyboard — WASD or arrows move · Space swings');
    if (state.lan.role === 'p2') { lanSetupReadyCheck(); return; }   // guest waits for the host
    startMatch();
    return;
  }
  toast(twoPlayer()
    ? '2P keyboard — P1: WASD + Space · P2: Arrows + Enter'
    : 'Keyboard mode — arrows move, Space swings');
  startMatch();
}

function wireControls() {
  // Intro
  el['btn-start'].addEventListener('click', () => { ensureAudio(); goToSetup(); });
  if (el['pose-opt']) {
    el['pose-opt'].checked = loadPoseOpt();
    el['pose-opt'].addEventListener('change', () => { ensureAudio(); setPoseOpt(el['pose-opt'].checked); });
  }
  for (const btn of el['mode-seg'].querySelectorAll('button')) {
    btn.addEventListener('click', () => { ensureAudio(); setMode(btn.dataset.mode); });
  }
  // Custom relay endpoint (deployed-site play). Saved on change; a blank
  // field clears it and falls back to this site's own /ws.
  el['relay-input'].addEventListener('change', () => {
    ensureAudio();
    const norm = setRelayInput(el['relay-input'].value);
    el['relay-input'].value = norm || '';
    if (state.lan.ws && state.screen === 'setup') {   // reconnect with the new endpoint
      lanTeardown();
      lanBeginSetup();
    } else {
      toast(norm ? `Relay saved — ${relayLabel()}` : 'Using this site as the relay');
    }
  });
  // Optional private room code (appended to the WebSocket URL; the server
  // rejects a second peer whose code doesn't match the first peer's code).
  if (el['lan-code']) {
    el['lan-code'].addEventListener('change', () => {
      try {
        const v = (el['lan-code'].value || '').trim().slice(0, 4);
        el['lan-code'].value = v;
        if (v) localStorage.setItem(LAN_CODE_KEY, v);
        else localStorage.removeItem(LAN_CODE_KEY);
      } catch { /* storage may be unavailable */ }
      if (state.lan.ws && state.screen === 'setup') {   // reconnect with the new code
        lanTeardown();
        lanBeginSetup();
      }
    });
  }
  for (const btn of el['difficulty-seg'].querySelectorAll('button')) {
    btn.addEventListener('click', () => setDifficulty(btn.dataset.diff));
  }

  // Setup
  el['btn-start-match'].addEventListener('click', () => { ensureAudio(); startMatch(); });
  el['btn-keyboard-mode'].addEventListener('click', () => { ensureAudio(); startKeyboardMode(); });
  if (el['btn-calib-skip']) el['btn-calib-skip'].addEventListener('click', () => { ensureAudio(); skipCalibration(); });

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
  lanTick();   // LAN lobby bookkeeping (readiness sync) — a no-op otherwise

  // LAN guest: a render-only device — it never simulates the match.
  if (isLan() && state.lan.role === 'p2') { updateLanGuest(dt, nowMs); return; }

  // Paddles follow hands on the setup screen too (live preview).
  if (state.screen === 'setup') {
    if (state.inputMode === 'hand') { updateHandInput(dt); updateCalibration(dt); }
    if (isLan()) lanHostStep(dt, nowMs);
    return;
  }
  if (state.screen !== 'play' || state.paused) return;

  if (state.inputMode === 'hand') updateHandInput(dt);
  else updateKeyboardInput(dt);
  updateHandHints();
  if (isLan()) lanHostStep(dt, nowMs);     // fold the peer's paddle into the sim + broadcast

  // Bullet-time window: eases ball-time toward the incoming-ball target
  // (1 everywhere except inside a human receiver's strike zone).
  updateSlowMo(dt);

  if (state.phase === 'countdown') {
    state.timer -= dt;
    const n = Math.max(1, Math.ceil(state.timer / COUNTDOWN_STEP));
    if (n !== state.lastCountdown) {
      state.lastCountdown = n;
      showBanner(String(n), hasBot() ? 'First to 11 — win by 2' : 'P1 vs P2 — first to 11');
      blip(440, 0.05, 'sine', 0.045);
    }
    if (state.timer <= 0) beginServe();
  } else if (state.phase === 'serve') {
    state.serveTimer += dt;
    const b = state.ball;
    const aiServing = state.serveSide === 'ai' && hasBot();
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
    stepAI(dt);                          // the AI moves/reacts in REAL time
    stepBall(dt * state.slowMo, true);   // …only the incoming ball glides
  } else if (state.phase === 'point') {
    state.timer -= dt;
    stepBall(dt, false);      // let the ball settle visually
    if (state.timer <= 0) afterPoint();
  }
}

const PERF_OVERLAY = new URLSearchParams(location.search).has('perf');
let perfOverlayEl = null;
let lastPerfOverlayMs = 0;

function noteFramePacing(ts) {
  // rAF deltas are what the player feels — any hitch anywhere (render,
  // tracking, audio, GC) shows up here. Cheap: a few arithmetic ops.
  if (!lastTs) return;
  const ms = ts - lastTs;
  if (!(ms >= 0 && ms < 1000)) return;   // ignore tab-switch gaps
  const p = state.perf;
  p.frameEmaMs += (ms - p.frameEmaMs) * 0.06;
  if (ms > p.frameWorstMs) p.frameWorstMs = ms;
  if (ms > 34) p.slowFrameCount++;
  if (PERF_OVERLAY) updatePerfOverlay(ms);
}

function updatePerfOverlay(ms) {
  try {
    if (!perfOverlayEl) {
      perfOverlayEl = document.createElement('div');
      perfOverlayEl.id = 'perf-stats';
      perfOverlayEl.style.cssText =
        'position:fixed;left:8px;top:8px;z-index:99;font:11px/1.5 monospace;' +
        'color:#9fe8ff;background:rgba(4,8,16,.72);border:1px solid rgba(77,215,255,.35);' +
        'border-radius:8px;padding:6px 9px;pointer-events:none;white-space:pre;';
      document.body.appendChild(perfOverlayEl);
    }
    const now = performance.now();
    if (now - lastPerfOverlayMs < 250) return;
    lastPerfOverlayMs = now;
    const p = state.perf;
    perfOverlayEl.textContent =
      `frame ${p.frameEmaMs.toFixed(1)}ms ema / worst ${p.frameWorstMs.toFixed(0)}ms\n` +
      `slow(>34ms) ${p.slowFrameCount}  longtask ${p.longtasks}x${p.longtaskMaxMs.toFixed(0)}ms\n` +
      `infer rtt ${p.rtt.toFixed(0)}ms ${p.inferMs.toFixed(0)}ms  trackW ${p.trackW}\n` +
      `src ${state.hand.trackSrc}  syncRuns ${p.syncRuns}  resets ${p.inflightResets}`;
  } catch { /* overlay must never break gameplay */ }
}

function watchLongTasks() {
  // Counts main-thread tasks >50ms (the user-visible hitches) with zero
  // per-frame cost. Chromium-only; guarded everywhere else.
  try {
    if (typeof PerformanceObserver !== 'function') return;
    const obs = new PerformanceObserver((list) => {
      try {
        for (const e of list.getEntries()) {
          state.perf.longtasks++;
          if (e.duration > state.perf.longtaskMaxMs) {
            state.perf.longtaskMaxMs = e.duration;
          }
        }
      } catch { /* ignore */ }
    });
    obs.observe({ entryTypes: ['longtask'] });
  } catch { /* unsupported — fine */ }
}

function getPerf() {
  const p = state.perf;
  return {
    frameEmaMs: +p.frameEmaMs.toFixed(2),
    frameWorstMs: +p.frameWorstMs.toFixed(1),
    slowFrameCount: p.slowFrameCount,
    longtasks: p.longtasks,
    longtaskMaxMs: +p.longtaskMaxMs.toFixed(1),
    rtt: +p.rtt.toFixed(1),
    inferMs: +p.inferMs.toFixed(1),
    trackW: p.trackW,
    sends: p.sends,
    dropped: p.dropped,
    inflightResets: p.inflightResets,
    syncRuns: p.syncRuns,
    trackSrc: (state.hand && state.hand.trackSrc) || 'none',
  };
}

let shadowDowngraded = false;     // one-way (with hysteresis) quality drop
let slowWindowStart = 0;

function maybeDowngradeShadows(ts) {
  // Uses the existing frame-pacing telemetry (state.perf.frameEmaMs). If the
  // EMA stays elevated (>28ms) for ~3s, disable the shadow map once — the
  // single most expensive setting on the table — then re-enable if frames
  // recover below 20ms (hysteresis avoids oscillation).
  if (shadowDowngraded) {
    if (state.perf.frameEmaMs < 20 && world.renderer) {
      shadowDowngraded = false;
      try { world.renderer.shadowMap.enabled = true; world.renderer.shadowMap.needsUpdate = true; } catch { /* ignore */ }
    }
    return;
  }
  if (state.perf.frameEmaMs > 28) {
    if (!slowWindowStart) slowWindowStart = ts;
    else if (ts - slowWindowStart > 3000) {
      shadowDowngraded = true;
      try { world.renderer.shadowMap.enabled = false; world.renderer.shadowMap.needsUpdate = true; } catch { /* ignore */ }
      if (PERF_OVERLAY) console.log('[airsmash] shadows disabled (sustained slow frames)');
    }
  } else {
    slowWindowStart = 0;
  }
}

function frame(ts) {
  if (contextLost) { requestAnimationFrame(frame); return; }   // loop paused; resume on restore
  const dt = Math.min(0.05, lastTs ? (ts - lastTs) / 1000 : 0.016);
  noteFramePacing(ts);
  maybeDowngradeShadows(ts);
  lastTs = ts;
  update(dt, ts);
  renderScene(dt);
  if (!el.preview.classList.contains('hidden')) drawPreview();
  syncHud();
  stepConfetti(dt);
  requestAnimationFrame(frame);
}

/* ============================================================
   21. LAN MULTIPLAYER — two devices on one network
   ============================================================
   One device runs `node lan-server.js` (static files + a tiny
   WebSocket room relay, zero dependencies). Both players open the
   printed address; the server casts the first connection as P1 (host)
   and the second as P2 (guest).

   Topology: HOST-AUTHORITATIVE. The host runs the full simulation and
   broadcasts compact state snapshots (~20Hz). The guest renders its own
   POV from those snapshots, streams its paddle pose back (~30Hz), and
   never simulates. Banners + sounds are replayed on the guest via small
   events so both sides see and hear the same match. */

/* ---- Relay endpoint (option 3: play from a deployed site) ----
   Priority: ?relay=<url> query param → saved localStorage value →
   same-origin `/ws` (the bundled lan-server.js). Accepts bare hosts
   ('my-relay.fly.dev', 'host:8080'), http(s) URLs (converted), or full
   ws(s):// URLs; a missing path gets '/ws' appended. */

const RELAY_KEY = 'airsmash.relay.v1';
const LAN_CODE_KEY = 'airsmash.lanCode.v1';

function normalizeRelayUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v)
      ? v
      : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${v}`);
  } catch {
    return null;
  }
  if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
  return u.toString();
}

function resolveRelayUrl() {
  try {
    const param = new URLSearchParams(location.search).get('relay');
    if (param) {
      const norm = normalizeRelayUrl(param);
      if (norm) localStorage.setItem(RELAY_KEY, norm);   // remember for next visit
      return norm;                                       // null param value falls back below
    }
    const saved = localStorage.getItem(RELAY_KEY);
    if (saved) return normalizeRelayUrl(saved);
  } catch { /* storage may be unavailable */ }
  return null;
}

// Human-readable target for the lobby note.
function relayLabel() {
  if (!state.lan.relayUrl) return 'this site';
  try { return new URL(state.lan.relayUrl).host; } catch { return state.lan.relayUrl; }
}

// Save/clear the custom relay from the intro input. Returns normalized URL.
function setRelayInput(raw) {
  const norm = normalizeRelayUrl(raw);
  try {
    if (norm) localStorage.setItem(RELAY_KEY, norm);
    else localStorage.removeItem(RELAY_KEY);
  } catch { /* ignore */ }
  state.lan.relayUrl = resolveRelayUrl();
  return norm;
}

function lanConnect() {
  if (state.lan.ws && (state.lan.ws.readyState === 0 || state.lan.ws.readyState === 1)) return;
  let ws;
  try {
    let url = state.lan.relayUrl
      || ((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws');
    const code = ((el['lan-code'] && el['lan-code'].value) || '').trim();
    if (code) url += (url.includes('?') ? '&' : '?') + 'code=' + encodeURIComponent(code);
    ws = new WebSocket(url);
  } catch {
    lanUnavailable();
    return;
  }
  state.lan.ws = ws;
  ws.onmessage = (e) => {
    let m = null;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m) lanHandleMessage(m);
  };
  ws.onerror = () => { if (!state.lan.role) lanUnavailable(); };
  ws.onclose = () => {
    const hadRole = !!state.lan.role;
    lanResetConn();
    if (hadRole && isLan() && state.screen === 'play') {
      toast('LAN connection lost');
      goToIntro(false);
    } else if (!hadRole && isLan() && state.screen === 'setup') {
      lanUnavailable();
    }
  };
}

// Host-only broadcast of presentation events (banners, sounds, game over).
function lanEmit(evt) {
  if (!isLan() || state.lan.role !== 'p1') return;
  evt.t = 'evt';
  lanSend(evt);
}

function lanSend(obj) {
  try {
    const ws = state.lan.ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch { /* a dropped frame must never break gameplay */ }
}

function lanUnavailable() {
  showError('LAN server unreachable',
    state.lan.relayUrl
      ? `Could not reach the relay at ${relayLabel()}. Is \`node lan-server.js\` running there (and serving /ws)? Fix the address in the “Relay server” box on the menu.`
      : 'LAN play needs the bundled relay. On one device run: node lan-server.js — then open the address it prints on BOTH devices. Playing from a deployed site? Paste a relay address in the “Relay server” box on the menu.');
}

function lanResetConn() {
  state.lan.ws = null;
  state.lan.role = null;
  state.lan.connected = false;
  state.lan.peerReady = false;
  state.lan.remoteMsg = null;
  state.lan.remotePad = null;
  state.lan.lastReadySent = null;
}

function lanTeardown() {
  if (state.lan.ws) {
    try { state.lan.ws.onclose = null; state.lan.ws.close(); } catch { /* ignore */ }
  }
  lanResetConn();
  if (el['lan-note']) el['lan-note'].classList.add('hidden');
}

function lanBeginSetup() {
  el['lan-note'].classList.remove('hidden');
  state.lan.peerReady = false;
  state.lan.lastReadySent = null;
  const code = ((el['lan-code'] && el['lan-code'].value) || '').trim();
  lanUpdateNote(code
    ? `Connecting to the relay (${relayLabel()}) — private room code ${code}…`
    : `Connecting to the relay (${relayLabel()}) — open room (anyone can join)…`);
  lanConnect();
}

function lanUpdateNote(text) {
  if (el['lan-note']) el['lan-note'].textContent = text;
}

function lanHandleMessage(m) {
  switch (m.t) {
    case 'welcome': {
      const prev = state.lan.role;
      state.lan.role = m.role;
      if (prev && prev !== m.role) {         // room reshuffled — start clean
        if (state.screen === 'play') { toast('Player slots changed'); goToIntro(false); }
        state.lan.peerReady = false;
      }
      setupReadyCheck();
      break;
    }
    case 'peers': {
      const wasConnected = state.lan.connected;
      state.lan.connected = m.n >= 2;
      if (state.lan.connected && !wasConnected) state.lan.peerReady = false;
      if (!state.lan.connected && wasConnected && state.screen === 'play') {
        toast('Your opponent disconnected');
        goToIntro(false);
      } else {
        setupReadyCheck();
      }
      break;
    }
    case 'full':
      toast('That room already has two players');
      lanTeardown();
      break;
    case 'ready':
      state.lan.peerReady = !!m.v;
      setupReadyCheck();
      break;
    case 'start':
      lanApplyingRemote = true;
      try { startMatch(); } finally { lanApplyingRemote = false; }
      break;
    case 'pad':
      if (state.lan.role === 'p1') state.lan.remotePad = m;
      break;
    case 'st':
      if (state.lan.role === 'p2') state.lan.remoteMsg = m;
      break;
    case 'evt':
      if (state.lan.role !== 'p2') break;
      if (m.k === 'banner') showBanner(m.text, m.sub, m.tone);
      else if (m.k === 'hide') hideBanner();
      else if (m.k === 'blip') playTone(m.f, m.d, m.ty, m.g);
      else if (m.k === 'over') lanApplyGameOver(m);
      break;
    case 'pause':
      // Apply without echoing back (togglePause would rebroadcast).
      if (state.paused !== m.v) {
        state.paused = m.v;
        showScreen('play');
        if (m.v) hideBanner();
        else if (state.phase === 'serve') showServeBanner();
      }
      break;
    case 'quit':
      toast('Your opponent left the match');
      goToIntro(false);
      break;
  }
}

// Per-frame lobby bookkeeping: keep readiness in sync with the peer.
function lanTick() {
  if (!isLan() || !state.lan.role || !state.lan.connected) return;
  const amHost = state.lan.role !== 'p2';
  const calibOk = state.inputMode !== 'hand' || TEST_MODE || !amHost || state.hand.calib.done;
  const ready = (state.hand.everDetected || state.inputMode === 'keyboard') && calibOk;
  if (state.lan.lastReadySent !== ready) {
    state.lan.lastReadySent = ready;
    lanSend({ t: 'ready', v: ready });
  }
}

// Host: fold the guest's latest paddle sample into the sim + broadcast.
function lanHostStep(dt, nowMs) {
  const m = state.lan.remotePad;
  if (m) {
    const q = state.p2;
    const k = Math.min(1, dt * 22);          // smooth the 30Hz samples
    q.targetX = m.x; q.targetY = m.y;
    q.x += (m.x - q.x) * k;
    q.y += (m.y - q.y) * k;
    q.vx = m.vx; q.vy = m.vy; q.speed = m.sp;
    const rail = q.railZ !== undefined ? q.railZ : PADDLE_Z_FAR;
    const lunge = Math.min(0.18, q.speed * 0.045);
    q.z = rail + (rail > 0 ? -lunge : lunge);
  }
  if (state.screen !== 'play') return;
  if (nowMs - state.lan.lastStateSent >= LAN_STATE_MS) {
    state.lan.lastStateSent = nowMs;
    const b = state.ball;
    lanSend({
      t: 'st',
      ph: state.phase,
      sy: state.scoreYou, sa: state.scoreAI,
      sv: state.serveSide, r: state.rally, pz: state.paused,
      b: { x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, lh: b.lastHitter, v: b.visible },
      o: { x: state.player.x, y: state.player.y, z: state.player.z },
    });
  }
}

// Guest per-frame: local input + paddle streaming + apply host state.
function updateLanGuest(dt, nowMs) {
  if (state.screen === 'setup') {
    if (state.inputMode === 'hand') updateHandInput(dt);
    return;
  }
  if (state.screen !== 'play') return;

  if (state.inputMode === 'hand') updateHandInput(dt);
  else updateKeyboardInput(dt);
  updateHandHints();

  if (nowMs - state.lan.lastPadSent >= LAN_PAD_MS) {
    state.lan.lastPadSent = nowMs;
    const q = myPaddle();
    lanSend({ t: 'pad', x: q.x, y: q.y, vx: q.vx, vy: q.vy, sp: q.speed });
  }

  if (state.paused) return;
  lanApplyLatestState(dt);
  // Guest visual parity: ease ball-time locally (pure math on the synced
  // snapshot) so the ball glow matches the host's dilated sim. The sweep
  // cue is NOT played here — the host relays it as a blip event, so a
  // local one would double up.
  {
    const target = slowMoTarget();
    state.slowMo += (target - state.slowMo) * (1 - Math.exp(-dt * SLOWMO_RATE));
  }
}

// Guest: ease ball + opponent paddle toward the host's latest snapshot.
function lanApplyLatestState(dt) {
  const m = state.lan.remoteMsg;
  if (!m) return;

  state.scoreYou = m.sy;
  state.scoreAI = m.sa;
  state.serveSide = m.sv;
  state.rally = m.r;
  if (m.r > state.longestRally) state.longestRally = m.r;
  if (m.pz !== state.paused) {
    state.paused = m.pz;
    showScreen('play');
  }
  if (state.phase !== m.ph) {
    state.phase = m.ph;
    if (m.ph === 'serve') updateServeChip();
    if (m.ph !== 'rally') trailClear();
  }

  const b = state.ball, tb = m.b;
  b.visible = tb.v;
  b.lastHitter = tb.lh;
  b.vx = tb.vx; b.vy = tb.vy; b.vz = tb.vz;
  if (!b.visible || state.phase === 'serve' || state.phase === 'countdown') {
    b.x = tb.x; b.y = tb.y; b.z = tb.z;       // pinned balls snap (no laggy float)
  } else {
    const k = Math.min(1, dt * 16);
    b.x += (tb.x - b.x) * k;
    b.y += (tb.y - b.y) * k;
    b.z += (tb.z - b.z) * k;
  }

  const o = state.player, to = m.o, k2 = Math.min(1, dt * 14);
  o.x += (to.x - o.x) * k2;
  o.y += (to.y - o.y) * k2;
  o.z = to.z;
}

// Guest: rebuild the game-over overlay from the host's event.
function lanApplyGameOver(m) {
  el['gameover-emoji'].textContent = m.emoji;
  el['gameover-title'].textContent = m.title;
  el['gameover-title'].className = m.cls;
  el['gameover-score'].textContent = m.score;
  el['gameover-rally'].textContent = m.rally;
  el['gameover-diff'].textContent = m.diffLabel;
  state.phase = 'over';
  hideBanner();
  spawnConfetti();
  showScreen('play');
}

// LAN variant of the setup gate: one hand here + the peer ready over there.
// P1-only calibration: the host (P1) must finish it; the guest (P2) skips.
function lanSetupReadyCheck() {
  const camOk = state.cameraReady && state.modelReady;
  if (camOk) {
    setSetupProgress(1);
    el['setup-progress'].classList.add('hidden');
    setSetupStatus('Camera ready — show your hand ✋');
  }
  const amHostPre = state.lan.role !== 'p2';
  const calibOk = state.inputMode !== 'hand' || TEST_MODE || !amHostPre || state.hand.calib.done;
  const localReady = (state.hand.everDetected || state.inputMode === 'keyboard') && calibOk;
  const both = camOk && localReady && state.lan.connected && state.lan.peerReady;
  const amHost = state.lan.role === 'p1';
  const btn = el['btn-start-match'];
  btn.disabled = amHost ? !both : true;
  btn.textContent = amHost
    ? (both ? 'Start match' : 'Waiting for player 2…')
    : 'Waiting for host…';

  let note;
  const wsOpen = state.lan.ws && state.lan.ws.readyState <= 1;
  if (!wsOpen) note = 'Not connected — is `node lan-server.js` running?';
  else if (!state.lan.role) note = 'Connecting to the LAN room…';
  else if (!state.lan.connected) note = amHost
    ? `You are Player 1 (host). Player 2: open this same address (${location.host}) on their device.`
    : 'You are Player 2 — waiting for Player 1 (host)…';
  else if (!both) note = amHost
    ? 'Player 2 connected! Both players: show a hand ✋'
    : 'Connected to Player 1 — show your hand ✋ and wait for the host to start.';
  else note = amHost ? 'Both ready — start when you like.' : 'Ready! Waiting for the host to start…';
  lanUpdateNote(note);
}

/* ============================================================
   22. TEST SEAM — used by verify.js / capture.js (?test=1)
   ============================================================ */

function makeFakeSkeleton(opts) {
  // Builds a deterministic 21-point hand for tests. opts: {spread, curl,
  // roll, size, cx, cy, thumbSide}. spread = finger fan, curl 0=open..1=fist.
  // Guarantees palmSizeOf() === size and measured roll === roll by rotating
  // the wrist with the hand and scaling all points (incl. wrist) together.
  const o = Object.assign({ spread: 0.09, curl: 0, roll: 0, size: 0.09, cx: 0.5, cy: 0.5, thumbSide: 1 }, opts || {});
  const pts = [];
  const cosR = Math.cos(o.roll), sinR = Math.sin(o.roll);
  const rot = (dx, dy) => ({ x: o.cx + dx * cosR - dy * sinR, y: o.cy + dx * sinR + dy * cosR, z: 0 });
  pts[0] = rot(0, o.size);
  // Thumb: side encodes forehand (+1) vs backhand (-1) in unmirrored space.
  const tx = o.thumbSide * -0.06;
  pts[1] = rot(-0.03, 0.06);
  pts[2] = rot(tx / 2, 0.03);
  pts[3] = rot(tx, 0.01); pts[4] = rot(tx + o.thumbSide * -0.02, -0.01);
  const fingers = [
    { base: -0.045, len: 0.10 }, { base: -0.015, len: 0.115 },
    { base: 0.015, len: 0.105 }, { base: 0.045, len: 0.09 },
  ];
  const idx = [5, 9, 13, 17];
  const tips = [8, 12, 16, 20];
  const pips = [6, 10, 14, 18];
  const mids = [7, 11, 15, 19];
  for (let f = 0; f < 4; f++) {
    const bx = fingers[f].base * (o.spread / 0.09);
    const L = fingers[f].len * (o.size / 0.09);
    const curlDrop = o.curl * L * 0.55;
    pts[idx[f]] = rot(bx, -0.01);
    pts[pips[f]] = rot(bx, -0.01 - L * 0.4);
    pts[mids[f]] = rot(bx, -0.01 - L * 0.7 + curlDrop * 0.4);
    pts[tips[f]] = rot(bx, -0.01 - L + curlDrop);
  }
  // Scale palm size exactly: force wrist->middle_mcp distance = o.size
  // (scale every point, wrist included, around the center).
  try {
    const cur = Math.hypot(pts[9].x - pts[0].x, pts[9].y - pts[0].y) || 1;
    const k = o.size / cur;
    for (let i = 0; i < 21; i++) {
      pts[i] = { x: o.cx + (pts[i].x - o.cx) * k, y: o.cy + (pts[i].y - o.cy) * k, z: 0 };
    }
  } catch { /* ignore */ }
  return pts;
}

window.__airsmash = {
  state,
  TABLE,
  view,
  getPerf,
  analyseP1Hand,
  palmSizeOf,
  computeTrackRoi,
  slowMoTarget,
  // Calibration + pose seams.
  skipCalibration,
  setPoseOpt,
  makeFakeSkeleton,
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
    const target = slot === 1 ? state.hand2 : state.hand;
    target.landmarks = pts;
    target.lastAnalyzedLm = null;
  },
  setFakeGesture(powerMul, aimXTrim, punch) {
    state.hand.gesture = Object.assign({}, state.hand.gesture, {
      powerMul: powerMul == null ? 1 : powerMul,
      aimXTrim: aimXTrim == null ? 0 : aimXTrim,
      punch: punch == null ? 0 : punch,
    });
  },
  // Fake a pose-wrist sample (MIRRORED coords, like hand slots).
  // Drives the P1 arm fallback in ?test=1 (no pose worker there).
  setFakeArm(x, y, ex, ey) {
    state.pose.arm.x = x; state.pose.arm.y = y;
    state.pose.arm.ex = ex == null ? x : ex;
    state.pose.arm.ey = ey == null ? y : ey;
    state.pose.arm.present = true;
    state.pose.arm.vis = 1;
    state.pose.arm.lastSeenMs = performance.now();
  },
  clearFakeArm() {
    state.pose.arm.present = false;
    state.pose.arm.vis = 0;
    state.pose.arm.lastSeenMs = -1e9;
    state.pose.armPts = null;
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
  // Send a raw LAN protocol message (used by tests to simulate a peer).
  lanSend,
  // Force a WebGL context loss / restore (testing only). Uses the
  // WEBGL_lose_context extension; returns true if the extension is available
  // so callers can skip gracefully where it isn't (e.g. some headless GPUs).
  forceContextLoss() {
    try {
      const ext = world.renderer.getContext().getExtension('WEBGL_lose_context');
      if (!ext) return false;
      ext.loseContext();
      return true;
    } catch { return false; }
  },
  restoreContext() {
    try {
      const ext = world.renderer.getContext().getExtension('WEBGL_lose_context');
      if (!ext) return false;
      ext.restoreContext();
      return true;
    } catch { return false; }
  },
};

/* ============================================================
   BOOT
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  cacheDom();
  state.lan.relayUrl = resolveRelayUrl();
  if (el['relay-input'] && state.lan.relayUrl) el['relay-input'].value = state.lan.relayUrl;
  try { if (el['lan-code']) el['lan-code'].value = localStorage.getItem(LAN_CODE_KEY) || ''; } catch { /* ignore */ }
  try { if (el['pose-opt']) el['pose-opt'].checked = loadPoseOpt(); } catch { /* ignore */ }
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
  watchLongTasks();
  setMode(state.mode);
  setDifficulty(state.difficulty);
  syncSoundBtn();
  refreshIntroStats();
  syncOpponentVisibility();
  wireControls();
  showScreen('intro');
  requestAnimationFrame(frame);
});
