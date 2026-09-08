/* ============================================================
   AirSmash — hand-worker.js
   MediaPipe HandLandmarker running OFF the main thread.

   Why: `detectForVideo` is synchronous and can take 10–30 ms on
   the CPU delegate. Running it on the main thread stalls the
   render loop (the whole game judders at the inference rate).
   Here the main thread only grabs a frame (`createImageBitmap`,
   async + cheap, downscaled ROI crop) and transfers it; all
   inference happens here.

   Protocol (postMessage):
     → { type: 'init' }
     ← { type: 'ready' } | { type: 'error', message }
     → { type: 'frame', bitmap: ImageBitmap, ts, roi, numHands }
       (bitmap transferred; roi = full-frame fractions or null)
     ← { type: 'result', hands: [ {pts:[{x,y,z}×21], hand} ],
         handed, ts, roi, inferMs }
       (pts are in BITMAP space when roi is set — the main thread
       maps them back to full-frame video coords)
   ============================================================ */

'use strict';

// Keep in sync with the pinned version in app.js.
const MP_VERSION = '0.10.14';
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MP_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

let landmarker = null;
let lastTs = 0;

// Reusable per-hand landmark pools — avoids allocating 21 objects per hand on
// every inference (worker-thread GC pressure that can delay postMessage under
// load). MediaPipe returns exactly 21 landmarks per hand; two pools cover the
// numHands:2 cap. postMessage structured-clones these on send, so mutating the
// pool for the next frame is always safe.
const PT_POOL = [0, 1].map(() => Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 })));

async function init() {
  const vision = await import(MP_BUNDLE);
  const fileset = await vision.FilesetResolver.forVisionTasks(MP_WASM);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MP_MODEL, delegate },
    runningMode: 'VIDEO',
    numHands: 2,                     // capped per-message in the main thread
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
      postMessage({ type: 'result', hands: [], handed: [], ts: msg.ts, roi: msg.roi || null, inferMs: 0 });
      return;
    }
    // detectForVideo requires strictly increasing int timestamps.
    const ts = Math.max(Math.floor(msg.ts || 0), lastTs + 1);
    lastTs = ts;

    const hands = [];
    const handed = [];
    let inferMs = 0;
    let pts = null, nHands = 0;
    let handNames = [];
    try {
      const t0 = performance.now();
      const res = landmarker.detectForVideo(bmp, ts);
      inferMs = performance.now() - t0;
      const lms = (res && res.landmarks) || [];
      const rawHanded = (res && res.handedness) || [];
      const want = Math.min(msg.numHands || 2, 2);
      for (let hi = 0; hi < lms.length && hands.length < want; hi++) {
        const lm = lms[hi];
        const out = PT_POOL[hi % PT_POOL.length];
        for (let i = 0; i < lm.length; i++) { out[i].x = lm[i].x; out[i].y = lm[i].y; out[i].z = lm[i].z || 0; }
        let hand = null;
        try {
          const h = rawHanded[hi] && rawHanded[hi][0];
          hand = (h && (h.categoryName || h.displayName)) || null;
        } catch { hand = null; }
        hands.push({ pts: out, hand });
        handed.push(rawHanded[hi] || null);
        handNames.push(hand);
      }
      // Packed transfer: Float32Array (nHands*21*3) sent by transferable buffer.
      try {
        nHands = hands.length;
        if (nHands > 0) {
          pts = new Float32Array(nHands * 63);
          for (let hi = 0; hi < nHands; hi++) {
            const arr = hands[hi].pts;
            for (let i = 0; i < 21 && i < arr.length; i++) {
              const j = hi * 63 + i * 3;
              pts[j] = arr[i].x; pts[j + 1] = arr[i].y; pts[j + 2] = arr[i].z || 0;
            }
          }
        }
      } catch { pts = null; }
    } catch { /* a bad frame must never kill the worker */ }
    if (bmp && bmp.close) bmp.close();
    if (pts) {
      postMessage({ type: 'result', hands, handed, pts, nHands, handNames, ts: msg.ts, roi: msg.roi || null, inferMs }, [pts.buffer]);
    } else {
      postMessage({ type: 'result', hands, handed, ts: msg.ts, roi: msg.roi || null, inferMs });
    }
  }
};
