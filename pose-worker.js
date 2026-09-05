/* ============================================================
   AirSmash — pose-worker.js (body lean + ARM TRACKING)
   MediaPipe PoseLandmarker (lite) running OFF the main thread.

   Output per frame (all image coords UNMIRRORED, 0..1):
     · lean — shoulder-midpoint X offset (mirrored, -0.5..0.5)
     · arm  — both wrists/elbows + shoulders so the main thread can
       fall back to wrist tracking when the palm model loses the hand
       (fist, motion blur, occlusion). Side picking happens main-thread.
   Any failure degrades silently — hand play never depends on this
   worker.

   Protocol:
     → { type: 'init' }
     ← { type: 'ready' } | { type: 'error', message }
     → { type: 'frame', bitmap: ImageBitmap, ts }
     ← { type: 'result', lean, arm, ts }
   ============================================================ */

'use strict';

const MP_VERSION = '0.10.14';
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MP_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

let landmarker = null;
let lastTs = 0;

async function init() {
  const vision = await import(MP_BUNDLE);
  const fileset = await vision.FilesetResolver.forVisionTasks(MP_WASM);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MP_MODEL, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    landmarker = await vision.PoseLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch {
    landmarker = await vision.PoseLandmarker.createFromOptions(fileset, opts('CPU'));
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
      postMessage({ type: 'result', lean: 0, arm: null, ts: msg.ts });
      return;
    }
    const ts = Math.max(Math.floor(msg.ts || 0), lastTs + 1);
    lastTs = ts;
    let lean = 0;
    let arm = null;
    try {
      const res = landmarker.detectForVideo(bmp, ts);
      const lms = (res && res.landmarks && res.landmarks[0]) || null;
      // Shoulders: 11 = left, 12 = right (image coords, unmirrored).
      if (lms && lms[11] && lms[12]) {
        const mid = ((lms[11].x || 0.5) + (lms[12].x || 0.5)) / 2;
        lean = (1 - mid) - 0.5;   // mirrored like the hand path
      }
      if (lms) {
        // Wrists 15/16, elbows 13/14, shoulders 11/12. Visibility falls
        // back to 1 when the build omits it but coords look sane.
        const pt = (i) => {
          const p = lms[i];
          if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
          if (!(p.x >= -0.1 && p.x <= 1.1 && p.y >= -0.1 && p.y <= 1.1)) return null;
          const v = (typeof p.visibility === 'number') ? p.visibility
            : (typeof p.presence === 'number') ? p.presence : 1;
          return { x: p.x, y: p.y, v };
        };
        const lw = pt(15), rw = pt(16), le = pt(13), re = pt(14);
        const ls = pt(11), rs = pt(12);
        if (lw || rw) arm = { lw, rw, le, re, ls, rs };
      }
    } catch { lean = 0; arm = null; }
    if (bmp && bmp.close) bmp.close();
    postMessage({ type: 'result', lean, arm, ts: msg.ts });
  }
};
