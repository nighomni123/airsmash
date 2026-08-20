/* ============================================================
   AirSmash — app.js
   Camera hand-tracked air table tennis. Your hand is the paddle.

   Sections (banner-commented, top to bottom):
     1. Constants        — geometry, physics tuning, difficulty table
     2. State            — single mutable state object
     3. DOM refs         — cacheDom()
     4. Layout           — canvas sizing + table geometry
     5. Persistence      — localStorage save/load
     6. Screen flow      — showScreen(), overlays
     7. Camera & tracking— getUserMedia + MediaPipe HandLandmarker
     8. Hand input       — mirror, map, smooth, velocity, hand-lost
     9. Match flow       — reset, serve, score, win
    10. Physics          — ball step, wall + paddle collisions
    11. AI               — difficulty-scaled opponent
    12. Rendering        — single render pass (canvas + HUD sync)
    13. Banner / Toast
    14. Sound            — lazy WebAudio blips
    15. Confetti
    16. Wiring           — buttons + keyboard
    17. Main loop
    18. Test seam        — window.__airsmash (used by verify/capture)
   ============================================================ */

'use strict';

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
const HAND_X_MIN = 0.08, HAND_X_MAX = 0.92;   // full table width
const HAND_Y_MIN = 0.30, HAND_Y_MAX = 0.95;   // player's half only
const SMOOTH_RATE = 18;                        // exp-filter rate (per second)
const HAND_LOST_MS = 500;                      // grace before "show your hand"

// Ball physics (px/sec unless noted).
const BALL_R = 9;
const BALL_SPEED_BASE = 430;
const BALL_SPEED_MAX = 980;
const BALL_SPEEDUP = 1.035;                    // per paddle hit
const WALL_DAMP = 1.0;                         // walls keep speed
const SPIN_FACTOR = 0.30;                      // hand velocity → ball vx
const PADDLE_V_CLAMP = 1500;                   // max paddle velocity fed to spin
const KEY_SPEED = 720;                         // keyboard fallback px/sec

// Paddles.
const PADDLE_W = 118, PADDLE_H = 20, PADDLE_R = 10;

// Match rules.
const WIN_SCORE = 11;
const WIN_BY = 2;
const SCORE_CAP = 15;                          // sudden death beyond this
const COUNTDOWN_STEP = 0.6;                    // seconds per countdown number
const BANNER_TIME = 1.15;                      // point banner duration

// Difficulty table: AI max speed, reaction delay, aim error, targeting.
const DIFFICULTY = {
  easy:   { label: 'Easy',   speed: 300, react: 0.22, error: 95, aimAway: false },
  normal: { label: 'Normal', speed: 430, react: 0.14, error: 55, aimAway: false },
  hard:   { label: 'Hard',   speed: 580, react: 0.08, error: 26, aimAway: true  },
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

const TEST_MODE = new URLSearchParams(location.search).has('test');
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ============================================================
   2. STATE
   ============================================================ */

const state = {
  screen: 'intro',           // intro | setup | error | play
  phase: 'idle',             // idle | serve | rally | point | over
  paused: false,
  difficulty: 'normal',
  inputMode: 'hand',         // hand | keyboard

  // Match
  scoreYou: 0,
  scoreAI: 0,
  rally: 0,
  longestRally: 0,
  serveSide: 'you',          // you | ai
  timer: 0,                  // phase countdown timer
  lastCountdown: -1,         // last countdown number shown in banner
  lastPointWinner: null,

  // Ball
  ball: { x: 0, y: 0, vx: 0, vy: 0, speed: BALL_SPEED_BASE, trail: [] },

  // Paddles (positions set by layout)
  player: { x: 0, y: 0, vx: 0, targetX: 0, targetY: 0 },
  ai: { x: 0, y: 0, vx: 0, targetX: 0, aimX: 0, aimErr: 0, reactT: 0 },

  // Hand tracking
  hand: {
    detected: false,
    everDetected: false,
    lostMs: 0,
    rawX: 0.5, rawY: 0.7,    // normalized, mirrored
    smX: 0.5, smY: 0.7,      // smoothed normalized
    landmarks: null,         // latest raw (unmirrored) landmarks, for skeleton
  },
  fakeHand: null,            // test seam: { x, y } normalized mirrored coords
  fakeBackground: null,      // test seam: canvas used as simulated camera feed

  // Setup
  cameraReady: false,
  modelReady: false,

  // Meta
  sound: true,
  stats: { wins: 0, losses: 0, bestRally: 0 },
};

const keys = { left: false, right: false, up: false, down: false };

/* ============================================================
   3. DOM REFS
   ============================================================ */

const el = {};

function cacheDom() {
  const ids = [
    'camera', 'game', 'confetti', 'hud', 'score-you', 'score-ai',
    'rally-count', 'serve-chip', 'btn-sound', 'btn-pause',
    'banner', 'banner-text', 'banner-sub', 'hand-hint',
    'screen-intro', 'screen-setup', 'screen-error',
    'overlay-pause', 'overlay-gameover', 'toast',
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
const table = { x: 0, y: 0, w: 0, h: 0, netY: 0, bottomY: 0 };

function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.w = window.innerWidth;
  view.h = window.innerHeight;
  view.dpr = dpr;

  for (const [canvas] of [[el.game], [el.confetti]]) {
    canvas.width = Math.round(view.w * dpr);
    canvas.height = Math.round(view.h * dpr);
  }

  // Table: portrait → limited by width; landscape → limited by height.
  const topPad = 64, bottomPad = 26, sidePad = 18;
  const availW = view.w - sidePad * 2;
  const availH = view.h - topPad - bottomPad;

  let tw = Math.min(availW, 560);
  let th = tw * 1.42;
  if (th > availH) { th = availH; tw = th / 1.42; }
  tw = Math.max(tw, 220); th = Math.max(th, 300);

  table.w = tw;
  table.h = th;
  table.x = (view.w - tw) / 2;
  table.y = topPad + (availH - th) / 2;
  table.netY = table.y + th / 2;
  table.bottomY = table.y + th;

  // Paddle rails.
  state.player.y = table.bottomY - 34;
  state.ai.y = table.y + 34;
  clampPaddles();
}

function clampPaddles() {
  const half = PADDLE_W / 2;
  const lo = table.x + half + 4, hi = table.x + table.w - half - 4;
  state.player.x = Math.min(hi, Math.max(lo, state.player.x || table.x + table.w / 2));
  state.ai.x = Math.min(hi, Math.max(lo, state.ai.x || table.x + table.w / 2));
  state.player.targetX = Math.min(hi, Math.max(lo, state.player.targetX));
  state.player.targetY = Math.min(table.bottomY - 14, Math.max(table.netY + 26, state.player.targetY || state.player.y));
}

/* ============================================================
   5. PERSISTENCE
   ============================================================ */

function saveGame() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      sound: state.sound,
      difficulty: state.difficulty,
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
  if (name !== 'play') {
    el['hand-hint'].classList.add('hidden');
    el.banner.classList.add('hidden');
  }
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
  showScreen('intro');
}

function goToSetup() {
  state.inputMode = 'hand';
  state.hand.everDetected = false;
  el['btn-start-match'].disabled = true;
  el['btn-start-match'].textContent = 'Waiting for hand…';
  el['setup-progress'].classList.remove('hidden');
  setSetupStatus('Starting camera…');
  showScreen('setup');
  initCameraAndModel();
}

function setSetupStatus(msg) { el['setup-status'].textContent = msg; }

function setSetupProgress(frac) {
  el['setup-progress-bar'].style.width = Math.round(frac * 100) + '%';
}

function setupReadyCheck() {
  if (state.screen !== 'setup') return;
  if (state.cameraReady && state.modelReady) {
    setSetupProgress(1);
    el['setup-progress'].classList.add('hidden');
    setSetupStatus('Camera ready — show your hand ✋');
  }
  if (state.hand.everDetected) {
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
let landmarker = null;
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
    setSetupStatus(state.modelReady ? 'Camera ready — show your hand ✋' : 'Loading hand-tracking model…');
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
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

async function initHandModel() {
  if (TEST_MODE) { landmarker = { fake: true }; return; }
  setSetupProgress(0.15);
  visionModule = await import(/* @vite-ignore */ MP_BUNDLE);
  setSetupProgress(0.45);
  const fileset = await visionModule.FilesetResolver.forVisionTasks(MP_WASM);
  setSetupProgress(0.65);
  const make = (delegate) => visionModule.HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MP_MODEL, delegate },
    runningMode: 'VIDEO',
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    landmarker = await make('GPU');
  } catch {
    landmarker = await make('CPU');   // GPU unsupported (some iOS) → CPU
  }
  setSetupProgress(0.9);
}

// Called once per animation frame.
let lastVideoTime = -1;

function detectFrame(nowMs) {
  if (state.fakeHand) {
    // Test seam: pretend a hand is at the fake position.
    state.hand.rawX = state.fakeHand.x;
    state.hand.rawY = state.fakeHand.y;
    state.hand.detected = true;
    state.hand.lostMs = 0;
    // (landmarks left untouched — capture.js may inject a fake skeleton)
    if (!state.hand.everDetected) state.hand.everDetected = true;
    setupReadyCheck();
    return;
  }
  if (!landmarker || landmarker.fake) return;
  if (!video || video.readyState < 2 || !video.videoWidth) return;
  if (video.currentTime === lastVideoTime) return;   // no new frame yet
  lastVideoTime = video.currentTime;

  let result = null;
  try {
    result = landmarker.detectForVideo(video, nowMs);
  } catch { return; }

  const lm = result && result.landmarks && result.landmarks[0];
  if (lm) {
    let sx = 0, sy = 0;
    for (const i of PALM_IDX) { sx += lm[i].x; sy += lm[i].y; }
    sx /= PALM_IDX.length; sy /= PALM_IDX.length;
    state.hand.rawX = 1 - sx;          // mirror: your right = screen right
    state.hand.rawY = sy;
    state.hand.detected = true;
    state.hand.lostMs = 0;
    state.hand.landmarks = lm;
    if (!state.hand.everDetected) state.hand.everDetected = true;
    setupReadyCheck();
  } else {
    state.hand.detected = false;
    state.hand.landmarks = null;
  }
}

/* ============================================================
   8. HAND INPUT → PADDLE
   ============================================================ */

function updateHandInput(dt) {
  const hand = state.hand;

  if (hand.detected) {
    hand.lostMs = 0;
    // dt-adjusted exponential smoothing (framerate independent).
    const a = 1 - Math.exp(-dt * SMOOTH_RATE);
    hand.smX += (hand.rawX - hand.smX) * a;
    hand.smY += (hand.rawY - hand.smY) * a;

    // Map normalized hand position onto the player's half of the table.
    const nx = (hand.smX - HAND_X_MIN) / (HAND_X_MAX - HAND_X_MIN);
    const ny = (hand.smY - HAND_Y_MIN) / (HAND_Y_MAX - HAND_Y_MIN);
    const half = PADDLE_W / 2;
    state.player.targetX = table.x + Math.min(1.06, Math.max(-0.06, nx)) * table.w;
    state.player.targetY = table.netY + 26 + Math.min(1, Math.max(0, ny)) * (table.bottomY - 14 - (table.netY + 26));
    el['hand-hint'].classList.add('hidden');
  } else {
    hand.lostMs += dt * 1000;
    if (hand.lostMs > HAND_LOST_MS && state.screen === 'play' && !state.paused) {
      el['hand-hint'].classList.remove('hidden');
    }
    // Paddle coasts: targets stay where they were.
  }

  movePlayerPaddle(dt);
}

function updateKeyboardInput(dt) {
  const p = state.player;
  const dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  p.targetX = p.x + dx * KEY_SPEED * dt;
  p.targetY = p.y + dy * KEY_SPEED * dt;
  el['hand-hint'].classList.add('hidden');
  movePlayerPaddle(dt);
}

function movePlayerPaddle(dt) {
  const p = state.player;
  const half = PADDLE_W / 2;
  const lo = table.x + half + 4, hi = table.x + table.w - half - 4;
  const tx = Math.min(hi, Math.max(lo, p.targetX));
  const ty = Math.min(table.bottomY - 14, Math.max(table.netY + 26, p.targetY));

  const prevX = p.x;
  const a = 1 - Math.exp(-dt * 26);
  p.x += (tx - p.x) * a;
  p.y += (ty - p.y) * a;

  let vx = dt > 0 ? (p.x - prevX) / dt : 0;
  p.vx = Math.min(PADDLE_V_CLAMP, Math.max(-PADDLE_V_CLAMP, vx));
}

/* ============================================================
   9. MATCH FLOW
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
  state.ball.trail.length = 0;
  state.ai.aimErr = 0;
  state.ai.reactT = 0;
  state.ai.x = table.x + table.w / 2;
  state.ai.targetX = state.ai.x;
}

function startMatch() {
  resetMatch();
  showScreen('play');
  startServe();
}

function currentServer() {
  const total = state.scoreYou + state.scoreAI;
  if (state.scoreYou >= 10 && state.scoreAI >= 10) {
    return total % 2 === 0 ? 'you' : 'ai';      // deuce: alternate every point
  }
  const block = Math.floor(total / 2) % 2;      // blocks of 2, starting with player
  return block === 0 ? 'you' : 'ai';
}

function startServe() {
  state.phase = 'serve';
  state.timer = COUNTDOWN_STEP * 3;
  state.lastCountdown = -1;
  state.rally = 0;
  state.serveSide = currentServer();
  state.ball.speed = BALL_SPEED_BASE;
  state.ball.trail.length = 0;
  state.ball.vx = 0; state.ball.vy = 0;
  placeBallForServe();
  updateServeChip();
}

function placeBallForServe() {
  const b = state.ball;
  if (state.serveSide === 'you') {
    b.x = state.player.x;
    b.y = state.player.y - PADDLE_H / 2 - BALL_R - 6;
  } else {
    b.x = state.ai.x;
    b.y = state.ai.y + PADDLE_H / 2 + BALL_R + 6;
  }
}

function launchBall() {
  const b = state.ball;
  b.speed = BALL_SPEED_BASE;
  if (state.serveSide === 'you') {
    const ang = (-90 + (Math.random() * 44 - 22)) * Math.PI / 180;   // upward
    b.vx = Math.cos(ang) * b.speed;
    b.vy = Math.sin(ang) * b.speed;
  } else {
    // AI serves toward a random spot on the player's side.
    const targetX = table.x + table.w * (0.2 + Math.random() * 0.6);
    const targetY = table.netY + (table.bottomY - table.netY) * 0.6;
    const T = (targetY - b.y) / b.speed;
    b.vx = (targetX - b.x) / T;
    b.vy = b.speed;
    const mag = Math.hypot(b.vx, b.vy);
    b.vx = b.vx / mag * b.speed;
    b.vy = b.vy / mag * b.speed;
  }
  state.phase = 'rally';
  hideBanner();
  blip(520, 0.06, 'triangle', 0.05);
}

function scorePoint(winner) {
  if (state.phase !== 'rally') return;
  state.longestRally = Math.max(state.longestRally, state.rally);
  if (winner === 'you') state.scoreYou++; else state.scoreAI++;
  state.lastPointWinner = winner;
  state.phase = 'point';
  state.timer = BANNER_TIME;

  if (winner === 'you') {
    showBanner('Your point!', `${state.scoreYou} : ${state.scoreAI}`, 'you');
    blip(660, 0.09, 'sine', 0.07);
    setTimeout(() => blip(880, 0.12, 'sine', 0.07), 90);
  } else {
    showBanner('AI point', `${state.scoreYou} : ${state.scoreAI}`, 'ai');
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
  startServe();
}

function endMatch(winner) {
  state.phase = 'over';
  state.longestRally = Math.max(state.longestRally, state.rally);
  if (state.longestRally > state.stats.bestRally) state.stats.bestRally = state.longestRally;
  if (winner === 'you') state.stats.wins++; else state.stats.losses++;
  saveGame();

  const you = state.scoreYou, ai = state.scoreAI;
  el['gameover-emoji'].textContent = winner === 'you' ? '🏆' : '🤖';
  el['gameover-title'].textContent = winner === 'you' ? 'You win!' : 'AI wins';
  el['gameover-title'].className = winner === 'you' ? 'win' : 'lose';
  el['gameover-score'].textContent = `${you} : ${ai}`;
  el['gameover-rally'].textContent = state.longestRally;
  el['gameover-diff'].textContent = DIFFICULTY[state.difficulty].label;
  hideBanner();
  showScreen('play');   // reveals the game-over overlay

  if (winner === 'you') {
    spawnConfetti();
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => blip(f, 0.16, 'triangle', 0.07), i * 130));
  } else {
    [392, 330, 262].forEach((f, i) => setTimeout(() => blip(f, 0.18, 'sine', 0.06), i * 160));
  }
}

function updateServeChip() {
  el['serve-chip'].textContent = state.serveSide === 'you' ? 'Your serve' : 'AI serve';
}

/* ============================================================
   10. PHYSICS
   ============================================================ */

function stepPhysics(dt) {
  const b = state.ball;

  // Trail.
  b.trail.push({ x: b.x, y: b.y });
  if (b.trail.length > 10) b.trail.shift();

  // Substep so a fast ball can't tunnel through a paddle.
  const steps = Math.max(1, Math.ceil((Math.abs(b.vx) + Math.abs(b.vy)) * dt / (BALL_R * 0.9)));
  const sdt = dt / steps;

  for (let i = 0; i < steps; i++) {
    const prevY = b.y;
    b.x += b.vx * sdt;
    b.y += b.vy * sdt;

    // Side walls.
    const left = table.x + BALL_R, right = table.x + table.w - BALL_R;
    if (b.x < left) { b.x = left + (left - b.x); b.vx = Math.abs(b.vx) * WALL_DAMP; wallTick(); }
    else if (b.x > right) { b.x = right - (b.x - right); b.vx = -Math.abs(b.vx) * WALL_DAMP; wallTick(); }

    // Player paddle (ball moving down, crossing the paddle face).
    if (b.vy > 0) {
      const face = state.player.y - PADDLE_H / 2 - BALL_R;
      if (prevY <= face && b.y >= face && Math.abs(b.x - state.player.x) <= PADDLE_W / 2 + BALL_R * 0.6) {
        paddleHit(state.player, -1);
      }
    }

    // AI paddle (ball moving up).
    if (b.vy < 0) {
      const face = state.ai.y + PADDLE_H / 2 + BALL_R;
      if (prevY >= face && b.y <= face && Math.abs(b.x - state.ai.x) <= PADDLE_W / 2 + BALL_R * 0.6) {
        paddleHit(state.ai, 1);
      }
    }

    // Endlines → point.
    if (b.y < table.y - BALL_R * 2.5) { scorePoint('you'); return; }
    if (b.y > table.bottomY + BALL_R * 2.5) { scorePoint('ai'); return; }
  }
}

function paddleHit(paddle, dirY) {
  const b = state.ball;
  b.speed = Math.min(BALL_SPEED_MAX, b.speed * BALL_SPEEDUP);
  state.rally++;

  // Angle from hit position on the paddle face (−1 … 1).
  const hit = Math.min(1, Math.max(-1, (b.x - paddle.x) / (PADDLE_W / 2)));
  const maxAng = 62 * Math.PI / 180;
  let vx = Math.sin(hit * maxAng) * b.speed;

  // Spin from paddle (hand) velocity at contact.
  vx += paddle.vx * SPIN_FACTOR * 0.5;
  const maxVx = Math.sin(maxAng) * b.speed * 1.15;
  vx = Math.min(maxVx, Math.max(-maxVx, vx));

  b.vx = vx;
  b.vy = dirY * Math.sqrt(Math.max(b.speed * b.speed - vx * vx, (b.speed * 0.45) ** 2));

  // Reposition just outside the face.
  if (dirY < 0) b.y = state.player.y - PADDLE_H / 2 - BALL_R - 0.5;
  else b.y = state.ai.y + PADDLE_H / 2 + BALL_R + 0.5;

  const pitch = 300 + (b.speed / BALL_SPEED_MAX) * 380;
  blip(pitch, 0.045, 'square', 0.05);
  if (navigator.vibrate) { try { navigator.vibrate(12); } catch { /* ignore */ } }
}

function wallTick() {
  blip(210, 0.03, 'square', 0.028);
}

/* ============================================================
   11. AI
   ============================================================ */

function stepAI(dt) {
  const cfg = DIFFICULTY[state.difficulty];
  const ai = state.ai;
  const b = state.ball;

  ai.reactT -= dt;

  if (state.phase === 'rally' && b.vy < 0) {
    // Ball incoming: predict landing x at the AI rail (with reaction delay).
    if (ai.reactT <= 0) {
      const t = (b.y - (ai.y + PADDLE_H / 2)) / -b.vy;
      let predX = b.x + b.vx * Math.max(0, t);
      // Reflect prediction off the walls.
      const lo = table.x + BALL_R, hi = table.x + table.w - BALL_R, span = hi - lo;
      if (span > 0) {
        let rel = (predX - lo) % (2 * span);
        if (rel < 0) rel += 2 * span;
        predX = rel <= span ? lo + rel : lo + (2 * span - rel);
      }
      if (ai.aimErr === 0) {
        ai.aimErr = (Math.random() * 2 - 1) * cfg.error;
        if (cfg.aimAway) {
          // Hard: bias the return away from the player's current position.
          const away = state.player.x < table.x + table.w / 2 ? 1 : -1;
          ai.aimErr += away * cfg.error * 0.9;
        }
      }
      ai.targetX = predX + ai.aimErr;
      ai.reactT = cfg.react;
    }
  } else {
    // Drift back toward center between shots.
    ai.targetX = table.x + table.w / 2 + (b.x - table.x - table.w / 2) * 0.15;
    ai.aimErr = 0;
  }

  const half = PADDLE_W / 2;
  const lo = table.x + half + 4, hi = table.x + table.w - half - 4;
  const target = Math.min(hi, Math.max(lo, ai.targetX));
  const dx = target - ai.x;
  const maxStep = cfg.speed * dt;
  const prevX = ai.x;
  ai.x += Math.min(maxStep, Math.max(-maxStep, dx));
  ai.vx = dt > 0 ? Math.min(PADDLE_V_CLAMP, Math.max(-PADDLE_V_CLAMP, (ai.x - prevX) / dt)) : 0;
}

/* ============================================================
   12. RENDERING — single pass, canvas + HUD sync
   ============================================================ */

let ctx = null, confettiCtx = null;

function render() {
  const c = ctx;
  c.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

  drawBackground(c);
  drawTable(c);
  if (state.inputMode === 'hand' && (state.screen === 'setup' || state.screen === 'play')) {
    drawSkeleton(c);
  }
  if (state.screen === 'play' && (state.phase === 'serve' || state.phase === 'rally' || state.phase === 'point')) {
    drawBall(c);
  }
  if (state.screen === 'play' || state.screen === 'setup') {
    drawPaddles(c);
  }
  syncHud();
}

function drawBackground(c) {
  c.fillStyle = '#070b16';
  c.fillRect(0, 0, view.w, view.h);

  // Test-mode simulated camera feed (used by capture.js for honest screenshots).
  const feed = TEST_MODE ? state.fakeBackground : null;
  const liveVideo = !TEST_MODE && video && video.readyState >= 2 && video.videoWidth ? video : null;

  if (state.inputMode === 'hand' && (feed || liveVideo)) {
    // Mirrored camera feed, dimmed, behind everything.
    const src = feed || liveVideo;
    const sw = feed ? feed.width : liveVideo.videoWidth;
    const sh = feed ? feed.height : liveVideo.videoHeight;
    c.save();
    c.translate(view.w, 0);
    c.scale(-1, 1);
    c.globalAlpha = 0.5;
    const s = Math.max(view.w / sw, view.h / sh);
    const dw = sw * s, dh = sh * s;
    c.drawImage(src, (view.w - dw) / 2, (view.h - dh) / 2, dw, dh);
    c.restore();
    c.globalAlpha = 1;
    c.fillStyle = 'rgba(7, 11, 22, 0.62)';
    c.fillRect(0, 0, view.w, view.h);
  } else {
    // Ambient arena glow when no camera feed is shown.
    const g = c.createRadialGradient(view.w / 2, view.h * 0.15, 40, view.w / 2, view.h * 0.15, view.h);
    g.addColorStop(0, 'rgba(53, 224, 140, 0.07)');
    g.addColorStop(1, 'rgba(7, 11, 22, 0)');
    c.fillStyle = g;
    c.fillRect(0, 0, view.w, view.h);
  }
}

function drawTable(c) {
  const { x, y, w, h } = table;

  // Table surface (slightly translucent so the camera ghosts through).
  const g = c.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, 'rgba(23, 52, 108, 0.94)');
  g.addColorStop(0.5, 'rgba(17, 40, 88, 0.94)');
  g.addColorStop(1, 'rgba(23, 52, 108, 0.94)');
  c.fillStyle = g;
  roundRect(c, x, y, w, h, 14);
  c.fill();

  // Outer glow.
  c.save();
  c.shadowColor = 'rgba(77, 215, 255, 0.28)';
  c.shadowBlur = 26;
  c.strokeStyle = 'rgba(238, 243, 255, 0.85)';
  c.lineWidth = 3;
  roundRect(c, x, y, w, h, 14);
  c.stroke();
  c.restore();

  // Boundary lines.
  c.strokeStyle = 'rgba(238, 243, 255, 0.55)';
  c.lineWidth = 2;
  roundRect(c, x + 8, y + 8, w - 16, h - 16, 8);
  c.stroke();

  // Center line (lengthwise, like a real table).
  c.strokeStyle = 'rgba(238, 243, 255, 0.22)';
  c.lineWidth = 2;
  c.setLineDash([10, 12]);
  c.beginPath();
  c.moveTo(x + w / 2, y + 10);
  c.lineTo(x + w / 2, y + h - 10);
  c.stroke();
  c.setLineDash([]);

  // Net band.
  const netG = c.createLinearGradient(x, 0, x + w, 0);
  netG.addColorStop(0, 'rgba(238, 243, 255, 0.10)');
  netG.addColorStop(0.5, 'rgba(238, 243, 255, 0.30)');
  netG.addColorStop(1, 'rgba(238, 243, 255, 0.10)');
  c.fillStyle = netG;
  c.fillRect(x - 6, table.netY - 3, w + 12, 6);
  c.fillStyle = 'rgba(238, 243, 255, 0.8)';
  c.fillRect(x - 6, table.netY - 3, 6, 6);
  c.fillRect(x + w, table.netY - 3, 6, 6);
}

function drawSkeleton(c) {
  const lm = state.hand.landmarks;
  if (!lm) {
    if (state.fakeHand && state.screen === 'setup') drawFakeHandMarker(c);
    return;
  }
  const px = (p) => ({ x: (1 - p.x) * view.w, y: p.y * view.h });   // mirrored
  c.save();
  c.strokeStyle = 'rgba(77, 215, 255, 0.45)';
  c.lineWidth = 2.5;
  c.lineCap = 'round';
  for (const [a, b] of HAND_CONNECTIONS) {
    const pa = px(lm[a]), pb = px(lm[b]);
    c.beginPath();
    c.moveTo(pa.x, pa.y);
    c.lineTo(pb.x, pb.y);
    c.stroke();
  }
  c.fillStyle = 'rgba(77, 215, 255, 0.7)';
  for (const p of lm) {
    const q = px(p);
    c.beginPath();
    c.arc(q.x, q.y, 3.5, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
}

function drawFakeHandMarker(c) {
  // Test-mode setup preview: a soft marker where the fake hand sits.
  const x = state.fakeHand.x * view.w;
  const y = state.fakeHand.y * view.h;
  c.save();
  c.strokeStyle = 'rgba(77, 215, 255, 0.6)';
  c.lineWidth = 2;
  c.beginPath();
  c.arc(x, y, 26, 0, Math.PI * 2);
  c.stroke();
  c.beginPath();
  c.arc(x, y, 5, 0, Math.PI * 2);
  c.fillStyle = 'rgba(77, 215, 255, 0.8)';
  c.fill();
  c.restore();
}

function drawBall(c) {
  const b = state.ball;

  // Trail.
  for (let i = 0; i < b.trail.length; i++) {
    const t = b.trail[i];
    const f = (i + 1) / b.trail.length;
    c.globalAlpha = f * 0.22;
    c.fillStyle = '#4dd7ff';
    c.beginPath();
    c.arc(t.x, t.y, BALL_R * (0.4 + f * 0.55), 0, Math.PI * 2);
    c.fill();
  }
  c.globalAlpha = 1;

  // Shadow.
  c.fillStyle = 'rgba(0, 0, 0, 0.3)';
  c.beginPath();
  c.ellipse(b.x + 4, b.y + 6, BALL_R * 0.9, BALL_R * 0.55, 0, 0, Math.PI * 2);
  c.fill();

  // Ball with glow.
  c.save();
  c.shadowColor = 'rgba(255, 255, 255, 0.75)';
  c.shadowBlur = 16;
  const g = c.createRadialGradient(b.x - 3, b.y - 3, 1, b.x, b.y, BALL_R);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(1, '#ffd166');
  c.fillStyle = g;
  c.beginPath();
  c.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

function drawPaddles(c) {
  if (state.screen === 'play' || (state.screen === 'setup' && state.hand.everDetected)) {
    drawPaddle(c, state.player.x, state.player.y, '#35e08c', 'rgba(53, 224, 140, 0.5)');
  }
  if (state.screen === 'play') {
    drawPaddle(c, state.ai.x, state.ai.y, '#ff5d73', 'rgba(255, 93, 115, 0.5)');
  }
}

function drawPaddle(c, x, y, color, glow) {
  c.save();
  c.shadowColor = glow;
  c.shadowBlur = 20;
  const g = c.createLinearGradient(x - PADDLE_W / 2, y, x + PADDLE_W / 2, y);
  g.addColorStop(0, color);
  g.addColorStop(0.5, '#eef3ff');
  g.addColorStop(1, color);
  c.fillStyle = g;
  roundRect(c, x - PADDLE_W / 2, y - PADDLE_H / 2, PADDLE_W, PADDLE_H, PADDLE_R);
  c.fill();
  c.restore();
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
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
   13. BANNER / TOAST
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
   14. SOUND — lazy WebAudio, never breaks gameplay
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
   15. CONFETTI
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
   16. WIRING
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
    if (state.phase === 'serve') state.lastCountdown = -1;   // redraw countdown banner
    blip(500, 0.06, 'sine', 0.04);
  }
}

function startKeyboardMode() {
  state.inputMode = 'keyboard';
  toast('Keyboard mode — arrow keys move the paddle');
  startMatch();
}

function wireControls() {
  // Intro
  el['btn-start'].addEventListener('click', () => { ensureAudio(); goToSetup(); });
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

  // Keyboard
  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'a') { keys.left = true; e.preventDefault(); }
    else if (k === 'ArrowRight' || k === 'd') { keys.right = true; e.preventDefault(); }
    else if (k === 'ArrowUp' || k === 'w') { keys.up = true; e.preventDefault(); }
    else if (k === 'ArrowDown' || k === 's') { keys.down = true; e.preventDefault(); }
    else if (k === 'p' || k === 'P' || k === 'Escape') togglePause();
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'a') keys.left = false;
    else if (k === 'ArrowRight' || k === 'd') keys.right = false;
    else if (k === 'ArrowUp' || k === 'w') keys.up = false;
    else if (k === 'ArrowDown' || k === 's') keys.down = false;
  });
  window.addEventListener('blur', () => {
    keys.left = keys.right = keys.up = keys.down = false;
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
   17. MAIN LOOP
   ============================================================ */

let lastTs = 0;

function update(dt, nowMs) {
  detectFrame(nowMs);

  if (state.screen !== 'play' || state.paused) return;

  if (state.inputMode === 'hand') updateHandInput(dt);
  else updateKeyboardInput(dt);

  if (state.phase === 'serve') {
    placeBallForServe();      // ball rides the server's paddle during countdown
    stepAI(dt);
    state.timer -= dt;
    const n = Math.max(1, Math.ceil(state.timer / COUNTDOWN_STEP));
    if (n !== state.lastCountdown) {
      state.lastCountdown = n;
      showBanner(String(n), state.serveSide === 'you' ? 'Your serve — get ready' : 'AI serving…');
      blip(440, 0.05, 'sine', 0.045);
    }
    if (state.timer <= 0) launchBall();
  } else if (state.phase === 'rally') {
    stepAI(dt);
    stepPhysics(dt);
  } else if (state.phase === 'point') {
    state.timer -= dt;
    if (state.timer <= 0) afterPoint();
  }
}

function frame(ts) {
  const dt = Math.min(0.05, lastTs ? (ts - lastTs) / 1000 : 0.016);
  lastTs = ts;
  update(dt, ts);
  render();
  stepConfetti(dt);
  requestAnimationFrame(frame);
}

/* ============================================================
   18. TEST SEAM — used by verify.js / capture.js (?test=1)
   ============================================================ */

window.__airsmash = {
  state,
  table,
  view,
  // Place a fake hand (normalized, mirrored coords: x 0..1 left→right, y 0..1 top→bottom).
  setFakeHand(x, y) { state.fakeHand = { x, y }; },
  clearFakeHand() { state.fakeHand = null; },
  // Fake hand skeleton for screenshots (unmirrored landmark-style points).
  setFakeLandmarks(pts) { state.hand.landmarks = pts; },
  // Simulated camera feed for screenshots (an offscreen canvas).
  setFakeBackground(canvas) { state.fakeBackground = canvas; },
  // Instantly end the serve countdown.
  skipCountdown() { if (state.phase === 'serve') state.timer = 0; },
  // Award a point as if the ball had crossed the endline.
  forceScore(side) {
    if (state.phase === 'serve') { state.phase = 'rally'; state.ball.vy = 1; }
    if (state.phase === 'rally') scorePoint(side);
  },
  // Advance the whole match to game over (for screenshots/tests).
  finishMatch(winner) {
    state.phase = 'rally';
    while (state.phase !== 'over') {
      const s = winner === 'you' ? state.scoreYou + 1 : state.scoreAI + 1;
      if (winner === 'you') state.scoreYou = s; else state.scoreAI = s;
      state.phase = 'point';
      afterPoint();
      if (state.phase === 'point') state.phase = 'rally';
      if (state.scoreYou + state.scoreAI > 60) break;   // safety valve
    }
  },
};

/* ============================================================
   BOOT
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  cacheDom();
  ctx = el.game.getContext('2d');
  confettiCtx = el.confetti.getContext('2d');
  layout();
  loadGame();
  setDifficulty(state.difficulty);
  syncSoundBtn();
  refreshIntroStats();
  state.player.x = table.x + table.w / 2;
  state.player.y = state.player.targetY = table.bottomY - 34;
  state.ai.x = table.x + table.w / 2;
  state.ai.targetX = state.ai.x;
  wireControls();
  showScreen('intro');
  requestAnimationFrame(frame);
});
