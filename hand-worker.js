/* ============================================================
   AirSmash — hand-worker.js
   MediaPipe HandLandmarker running OFF the main thread.

   Why: `detectForVideo` is synchronous and can take 10–30 ms on
   the CPU delegate. Running it on the main thread stalls the
   render loop (the whole game judders at the inference rate).
   Here the main thread only grabs a frame (`createImageBitmap`,
   async + cheap) and transfers it; all inference happens here.

   Protocol (postMessage):
     → { type: 'init' }
     ← { type: 'ready' } | { type: 'error', message }
     → { type: 'frame', bitmap: ImageBitmap, ts }   (bitmap transferred)
     ← { type: 'result', hands: [ [ {x,y} × 21 ] ], ts }
   ============================================================ */

'use strict';

// Keep in sync with the pinned version in app.js.
const MP_VERSION = '0.10.14';
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MP_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

let landmarker = null;
let lastTs = 0;

async function init() {
  const vision = await import(MP_BUNDLE);
  const fileset = await vision.FilesetResolver.forVisionTasks(MP_WASM);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MP_MODEL, delegate },
    runningMode: 'VIDEO',
    numHands: 2,                     // two-player mode tracks both hands
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch {
    // GPU/OffscreenCanvas unsupported in this worker → CPU still fine
    // because inference no longer blocks the render loop.
    landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts('CPU'));
  }
}

self.onmessage = (e) => {
  const msg = e.data || {};

  if (msg.type === 'init') {
    init()
      .then(() => postMessage({ type: 'ready' }))
      .catch((err) => postMessage({ type: 'error', message: String((err && err.message) || err) }));
    return;
  }

  if (msg.type === 'frame') {
    const bmp = msg.bitmap;
    if (!landmarker) {
      if (bmp && bmp.close) bmp.close();
      postMessage({ type: 'result', hands: [], ts: msg.ts });
      return;
    }
    // detectForVideo requires strictly increasing int timestamps.
    const ts = Math.max(Math.floor(msg.ts || 0), lastTs + 1);
    lastTs = ts;

    const hands = [];
    try {
      const res = landmarker.detectForVideo(bmp, ts);
      const lms = (res && res.landmarks) || [];
      for (const lm of lms) {
        const out = new Array(lm.length);
        for (let i = 0; i < lm.length; i++) out[i] = { x: lm[i].x, y: lm[i].y };
        hands.push(out);
      }
    } catch { /* a bad frame must never kill the worker */ }
    if (bmp && bmp.close) bmp.close();
    postMessage({ type: 'result', hands, ts });
  }
};
