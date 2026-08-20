/* ============================================================
   AirSmash — app.js  (3D first-person table tennis)
   Your hand is the paddle. Camera behind your end of the table,
   full view of the net, the opponent and the arena.

   Sections (banner-commented, top to bottom):
     1. Constants        — table dimensions, physics, difficulty
     2. State            — single mutable state object
     3. DOM refs         — cacheDom()
     4. Layout           — renderer/camera sizing
     5. Persistence      — localStorage save/load
     6. Screen flow      — showScreen(), overlays
     7. Camera & tracking— getUserMedia + MediaPipe HandLandmarker
     8. Hand input       — mirror, map to 3D paddle, swing velocity
     9. 3D scene         — arena, table, net, paddles, ball (Three.js)
    10. Match flow       — reset, serve, score, win
    11. Shot solver      — ballistic aim with net clearance
    12. Ball physics     — gravity, table bounce, net, out of bounds
    13. Player hitting   — swing detection + returns
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
const SMOOTH_RATE = 16;                        // exp-filter rate (per second)
const HAND_LOST_MS = 500;                      // grace before "show your hand"

// Paddle workspace (world meters, player's near side).
const PADDLE_X_RANGE = 1.05;
const PADDLE_Y_TOP = 1.62, PADDLE_Y_BOT = 0.82;
const PADDLE_Z = 1.05;
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

  // Match
  scoreYou: 0,
  scoreAI: 0,
  rally: 0,
  longestRally: 0,
  serveSide: 'you',          // you | ai
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

  // Paddles (world positions)
  player: { x: 0, y: 1.1, z: PADDLE_Z, vx: 0, vy: 0, vz: 0, speed: 0, targetX: 0, targetY: 1.1, hitCooldown: 0 },
  ai: { x: 0, y: 1.0, z: -1.15, vx: 0, targetX: 0, targetY: 1.0, hitCooldown: 0, reactT: 0, aimErrX: 0, aimErrZ: 0 },

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

const keys = { left: false, right: false, up: false, down: false, swing: 0 };

/* ============================================================
   3. DOM REFS
   ============================================================ */

const el = {};

function cacheDom() {
  const ids = [
    'camera', 'game', 'preview', 'confetti', 'hud', 'score-you', 'score-ai',
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

  const showPreview = state.inputMode === 'hand' && (name === 'setup' || name === 'play');
  el.preview.classList.toggle('hidden', !showPreview);
  el.preview.classList.toggle('in-play', name === 'play');

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
   8. HAND INPUT → 3D PADDLE
   ============================================================ */

function updateHandInput(dt) {
  const hand = state.hand;

  if (hand.detected) {
    hand.lostMs = 0;
    // dt-adjusted exponential smoothing (framerate independent).
    const a = 1 - Math.exp(-dt * SMOOTH_RATE);
    hand.smX += (hand.rawX - hand.smX) * a;
    hand.smY += (hand.rawY - hand.smY) * a;

    // Map normalized hand position into the 3D paddle workspace.
    const nx = (hand.smX - HAND_X_MIN) / (HAND_X_MAX - HAND_X_MIN);
    const ny = (hand.smY - HAND_Y_MIN) / (HAND_Y_MAX - HAND_Y_MIN);
    state.player.targetX = (Math.min(1.12, Math.max(-1.12, nx * 2 - 1))) * PADDLE_X_RANGE;
    state.player.targetY = PADDLE_Y_TOP - Math.min(1, Math.max(0, ny)) * (PADDLE_Y_TOP - PADDLE_Y_BOT);
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
  p.targetY = p.y - dy * KEY_SPEED * dt;
  el['hand-hint'].classList.add('hidden');
  movePlayerPaddle(dt);
}

function movePlayerPaddle(dt) {
  const p = state.player;
  const tx = Math.min(PADDLE_X_RANGE, Math.max(-PADDLE_X_RANGE, p.targetX));
  const ty = Math.min(PADDLE_Y_TOP, Math.max(PADDLE_Y_BOT, p.targetY));

  const prevX = p.x, prevY = p.y;
  const a = 1 - Math.exp(-dt * 24);
  p.x += (tx - p.x) * a;
  p.y += (ty - p.y) * a;

  // Swing velocity (used for spin, power and serve detection).
  if (dt > 0) {
    const ivx = (p.x - prevX) / dt;
    const ivy = (p.y - prevY) / dt;
    p.vx += (ivx - p.vx) * Math.min(1, dt * 20);
    p.vy += (ivy - p.vy) * Math.min(1, dt * 20);
  }
  let kb = 0;
  if (keys.swing > 0) { kb = 2.6; keys.swing = Math.max(0, keys.swing - dt * 6); }
  p.speed = Math.max(Math.hypot(p.vx, p.vy), kb);

  // Gentle forward lunge while swinging fast (visual only).
  p.z = PADDLE_Z - Math.min(0.18, p.speed * 0.045);
}

/* ============================================================
   9. 3D SCENE
   ============================================================ */

const world = {
  renderer: null, scene: null, camera: null,
  ball: null, ballShadow: null, trail: [],
  playerPaddle: null, aiPaddle: null, opponent: null,
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

  buildArena(scene);
  buildTable(scene);
  buildBall(scene);
  world.playerPaddle = buildPaddle(scene, 0xe23b4e, true);
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
}

function startMatch() {
  resetMatch();
  showScreen('play');
  state.phase = 'countdown';
  state.timer = COUNTDOWN_STEP * 3;
  state.lastCountdown = -1;
}

function currentServer() {
  const total = state.scoreYou + state.scoreAI;
  if (state.scoreYou >= 10 && state.scoreAI >= 10) {
    return total % 2 === 0 ? 'you' : 'ai';      // deuce: alternate every point
  }
  const block = Math.floor(total / 2) % 2;      // blocks of 2, starting with player
  return block === 0 ? 'you' : 'ai';
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
  if (state.serveSide === 'you') {
    showBanner('Your serve', 'Swipe through the ball to launch it');
  } else {
    showBanner('AI serve', 'Get ready…');
  }
}

function launchPlayerServe() {
  const b = state.ball;
  const p = state.player;
  const power = Math.min(3.5, 2.2 + p.speed * 0.35);
  const aimX = clampNum(p.vx * 0.14 + (Math.random() - 0.5) * 0.35, -0.62, 0.62);
  const v = solveShot({ x: b.x, y: b.y, z: b.z }, { x: aimX, y: TABLE.H + BALL_R, z: -(0.45 + Math.random() * 0.7) }, power);
  b.vx = v.vx; b.vy = v.vy; b.vz = v.vz;
  b.lastHitter = 'you';
  b.bounces = 0;
  b.validOpponentBounce = false;
  state.phase = 'rally';
  state.rally = 1;
  hideBanner();
  hitSound(power);
}

function launchAiServe() {
  const b = state.ball;
  const cfg = DIFFICULTY[state.difficulty];
  const aimX = (Math.random() - 0.5) * 1.0;
  const v = solveShot({ x: b.x, y: b.y, z: b.z },
    { x: aimX, y: TABLE.H + BALL_R, z: 0.5 + Math.random() * 0.7 }, cfg.returnSpeed - 0.3);
  b.vx = v.vx; b.vy = v.vy; b.vz = v.vz;
  b.lastHitter = 'ai';
  b.bounces = 0;
  b.validOpponentBounce = false;
  state.phase = 'rally';
  state.rally = 1;
  hideBanner();
  hitSound(cfg.returnSpeed);
}

function scorePoint(winner) {
  if (state.phase !== 'rally') return;
  state.longestRally = Math.max(state.longestRally, state.rally);
  if (winner === 'you') state.scoreYou++; else state.scoreAI++;
  state.lastPointWinner = winner;
  state.phase = 'point';
  state.timer = POINT_TIME;

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
  beginServe();
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

function stepPlayerHit(dt) {
  const p = state.player;
  p.hitCooldown = Math.max(0, p.hitCooldown - dt);
  const b = state.ball;

  if (state.phase !== 'rally' || b.lastHitter === 'you' || p.hitCooldown > 0) return;
  if (b.z < 0.22) return;                              // must be on your side of the net

  const dist = Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z);
  if (dist > PADDLE_REACH) return;

  // Contact! Aim the return using swing direction + a little randomness.
  const swing = Math.min(4, p.speed);
  const speed = clampNum(2.3 + state.rally * 0.08 + swing * 0.45, 2.3, 6.2);
  const aimX = clampNum(p.vx * 0.16 + (Math.random() - 0.5) * 0.3, -0.68, 0.68);
  const aimZ = -(0.45 + Math.random() * 0.8);
  const v = solveShot({ x: b.x, y: b.y, z: b.z }, { x: aimX, y: TABLE.H + BALL_R, z: aimZ }, speed);
  b.vx = v.vx; b.vy = v.vy; b.vz = v.vz;
  b.lastHitter = 'you';
  b.bounces = 0;
  b.validOpponentBounce = false;
  state.rally++;
  p.hitCooldown = 0.3;
  state.ai.reactT = DIFFICULTY[state.difficulty].react;
  state.ai.aimErrX = 0; state.ai.aimErrZ = 0;
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

  // Player paddle follows the smoothed targets; tilt with the swing.
  const pp = world.playerPaddle;
  pp.position.set(p.x, p.y, p.z);
  pp.rotation.z = clampNum(-p.vx * 0.05, -0.5, 0.5);
  pp.rotation.x = 0.12 + clampNum(p.vy * 0.04, -0.35, 0.35);

  // AI paddle.
  const ap = world.aiPaddle;
  ap.position.set(state.ai.x, state.ai.y, state.ai.z);
  ap.rotation.z = clampNum(state.ai.vx * 0.04, -0.4, 0.4);

  // Opponent leans toward the ball.
  if (world.opponent) {
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

  // Subtle camera sway with the paddle.
  world.camera.position.x += (p.x * 0.09 - world.camera.position.x) * Math.min(1, dt * 5);
  world.camera.lookAt(0, 0.78, -0.55);

  world.renderer.render(world.scene, world.camera);
}

// Picture-in-picture camera preview with hand skeleton.
function drawPreview() {
  const pc = previewCtx;
  const W = el.preview.width, H = el.preview.height;
  pc.fillStyle = '#05070d';
  pc.fillRect(0, 0, W, H);

  const feed = TEST_MODE ? state.fakeBackground : null;
  const liveVideo = !TEST_MODE && video && video.readyState >= 2 && video.videoWidth ? video : null;

  if (feed || liveVideo) {
    const src = feed || liveVideo;
    const sw = feed ? feed.width : liveVideo.videoWidth;
    const sh = feed ? feed.height : liveVideo.videoHeight;
    pc.save();
    pc.translate(W, 0);
    pc.scale(-1, 1);                       // mirrored, like a mirror
    const s = Math.max(W / sw, H / sh);
    pc.drawImage(src, (W - sw * s) / 2, (H - sh * s) / 2, sw * s, sh * s);
    pc.restore();

    const lm = state.hand.landmarks;
    if (lm) {
      pc.strokeStyle = 'rgba(77, 215, 255, 0.85)';
      pc.lineWidth = 2;
      pc.lineCap = 'round';
      for (const [a, bIdx] of HAND_CONNECTIONS) {
        pc.beginPath();
        pc.moveTo((1 - lm[a].x) * W, lm[a].y * H);
        pc.lineTo((1 - lm[bIdx].x) * W, lm[bIdx].y * H);
        pc.stroke();
      }
      pc.fillStyle = 'rgba(77, 215, 255, 0.95)';
      for (const pt of lm) {
        pc.beginPath();
        pc.arc((1 - pt.x) * W, pt.y * H, 3, 0, Math.PI * 2);
        pc.fill();
      }
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
    if (state.phase === 'serve' && state.serveSide === 'you') {
      showBanner('Your serve', 'Swipe through the ball to launch it');
    }
    blip(500, 0.06, 'sine', 0.04);
  }
}

function startKeyboardMode() {
  state.inputMode = 'keyboard';
  toast('Keyboard mode — arrows move, Space swings');
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
    else if (k === ' ') { keys.swing = 1; e.preventDefault(); }
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
   20. MAIN LOOP
   ============================================================ */

let lastTs = 0;

function update(dt, nowMs) {
  detectFrame(nowMs);

  // Paddle follows the hand on the setup screen too (live preview).
  if (state.screen === 'setup') {
    if (state.inputMode === 'hand') updateHandInput(dt);
    return;
  }
  if (state.screen !== 'play' || state.paused) return;

  if (state.inputMode === 'hand') updateHandInput(dt);
  else updateKeyboardInput(dt);

  if (state.phase === 'countdown') {
    state.timer -= dt;
    const n = Math.max(1, Math.ceil(state.timer / COUNTDOWN_STEP));
    if (n !== state.lastCountdown) {
      state.lastCountdown = n;
      showBanner(String(n), 'First to 11 — win by 2');
      blip(440, 0.05, 'sine', 0.045);
    }
    if (state.timer <= 0) beginServe();
  } else if (state.phase === 'serve') {
    state.serveTimer += dt;
    const b = state.ball;
    if (state.serveSide === 'you') {
      // Ball floats beside your paddle until you swipe it.
      b.x = state.player.x - 0.13;
      b.y = state.player.y + 0.06;
      b.z = state.player.z - 0.2;
      b.visible = true;
      if (state.player.speed > 1.15 || state.serveTimer > AUTO_SERVE_S) launchPlayerServe();
    } else {
      // AI holds the ball, then serves.
      b.x = state.ai.x + 0.12;
      b.y = state.ai.y + 0.06;
      b.z = state.ai.z + 0.18;
      b.visible = true;
      stepAI(dt);
      if (state.serveTimer > AI_SERVE_DELAY) launchAiServe();
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
  // Place a fake hand (normalized, mirrored coords: x 0..1 left→right, y 0..1 top→bottom).
  setFakeHand(x, y) { state.fakeHand = { x, y }; },
  clearFakeHand() { state.fakeHand = null; },
  // Fake hand skeleton for screenshots (unmirrored landmark-style points).
  setFakeLandmarks(pts) { state.hand.landmarks = pts; },
  // Simulated camera feed for screenshots (an offscreen canvas).
  setFakeBackground(canvas) { state.fakeBackground = canvas; },
  // End the match-start countdown immediately.
  skipCountdown() { if (state.phase === 'countdown') state.timer = 0; },
  // Launch the current serve immediately (whichever side).
  serveNow() {
    if (state.phase !== 'serve') return;
    if (state.serveSide === 'you') launchPlayerServe();
    else launchAiServe();
  },
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
  setDifficulty(state.difficulty);
  syncSoundBtn();
  refreshIntroStats();
  wireControls();
  showScreen('intro');
  requestAnimationFrame(frame);
});
