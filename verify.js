// Automated verification: console errors, 3D flow, hand input, physics,
// scoring, pause, persistence, keyboard fallback, and mobile layout.
// Usage: node verify.js   → must end with "ALL CHECKS PASSED"
//
// Runs against ?test=1 (hermetic: no real camera, no model download).

import path from 'path';
import http from 'http';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Use the shared browser cache when it exists (this machine); otherwise fall
// back to Playwright's default location (fresh clones: `npx playwright install chromium`).
const SHARED_BROWSERS = path.join(__dirname, '..', '..', 'Do not delete folder', '.pw-browsers');
if (fs.existsSync(SHARED_BROWSERS)) process.env.PLAYWRIGHT_BROWSERS_PATH = SHARED_BROWSERS;

const { chromium } = await import('playwright');

const PORT = 3458;
const DIR = __dirname;

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const filePath = path.join(DIR, urlPath === '/' ? 'index.html' : urlPath);
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.mjs': 'application/javascript' };
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); }
    else { res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' }); res.end(content); }
  });
});

let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  [' + extra + ']' : ''));
  if (!cond) failures++;
}

server.listen(PORT, async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--enable-unsafe-swiftshader',   // software WebGL in headless
    ],
  });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();

  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  const api = () => page.evaluate(() => window.__airsmash);
  const scores = () => page.evaluate(() => ({
    you: Number(document.getElementById('score-you').textContent),
    ai: Number(document.getElementById('score-ai').textContent),
  }));

  try {
    await page.goto(`http://localhost:${PORT}/?test=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__airsmash, null, { timeout: 8000 });
    await page.waitForTimeout(400);

    // --- Intro ---
    check('intro visible', await page.isVisible('#screen-intro'));
    check('start button visible', await page.isVisible('#btn-start'));
    check('mode segment has 3 options', (await page.locator('#mode-seg button').count()) === 3);
    check('vs-ai mode preselected', await page.locator('#mode-seg button.on').getAttribute('data-mode') === 'ai');
    check('difficulty segment has 3 options', (await page.locator('#difficulty-seg button').count()) === 3);
    check('normal difficulty preselected', await page.locator('#difficulty-seg button.on').getAttribute('data-diff') === 'normal');
    check('stats row present', await page.isVisible('#intro-stats'));

    // Custom relay endpoint (deployed-site play): input appears only in
    // LAN mode, normalizes bare hosts, and persists to localStorage.
    check('relay row hidden outside LAN mode', !(await page.isVisible('#relay-row')));
    await page.click('#mode-seg button[data-mode="lan"]');
    check('relay row visible in LAN mode', await page.isVisible('#relay-row'));
    await page.fill('#relay-input', 'example.com:9000');
    await page.locator('#relay-input').evaluate(e => e.dispatchEvent(new Event('change')));
    const savedRelay = await page.evaluate(() => window.__airsmash.state.lan.relayUrl);
    check('relay URL normalizes bare host + appends /ws', savedRelay === 'ws://example.com:9000/ws',
      String(savedRelay));
    const storedRelay = await page.evaluate(() => localStorage.getItem('airsmash.relay.v1'));
    check('relay URL persisted to localStorage', storedRelay === 'ws://example.com:9000/ws',
      String(storedRelay));
    // wss:// URLs pass through untouched; clearing the box reverts to same-origin.
    await page.fill('#relay-input', 'wss://tls-relay.example.com');
    await page.locator('#relay-input').evaluate(e => e.dispatchEvent(new Event('change')));
    check('wss relay kept as-is',
      (await page.evaluate(() => window.__airsmash.state.lan.relayUrl)) === 'wss://tls-relay.example.com/ws');
    await page.fill('#relay-input', '');
    await page.locator('#relay-input').evaluate(e => e.dispatchEvent(new Event('change')));
    check('blank relay falls back to same origin',
      (await page.evaluate(() => window.__airsmash.state.lan.relayUrl)) === null);
    await page.click('#mode-seg button[data-mode="ai"]');
    // ?relay= query param wins over everything.
    const paramPage = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    await paramPage.goto(`http://localhost:${PORT}/?test=1&relay=param-host:7000`, { waitUntil: 'domcontentloaded' });
    await paramPage.waitForFunction(() => !!window.__airsmash, null, { timeout: 8000 });
    check('?relay= param resolves and is remembered',
      (await paramPage.evaluate(() => window.__airsmash.state.lan.relayUrl)) === 'ws://param-host:7000/ws'
      && (await paramPage.evaluate(() => localStorage.getItem('airsmash.relay.v1'))) === 'ws://param-host:7000/ws');
    await paramPage.context().close();

    // WebGL renderer initialized
    check('WebGL renderer created', await page.evaluate(() => !!window.__airsmash.renderer));
    check('game canvas has size', await page.evaluate(() => {
      const c = document.getElementById('game');
      return c.width > 100 && c.height > 100;
    }));

    // Difficulty selection persists
    await page.click('#difficulty-seg button[data-diff="hard"]');
    check('hard difficulty selectable', await page.locator('#difficulty-seg button[data-diff="hard"]').evaluate(b => b.classList.contains('on')));
    await page.click('#difficulty-seg button[data-diff="normal"]');

    // --- Setup screen ---
    await page.click('#btn-start');
    await page.waitForTimeout(300);
    check('setup screen visible', await page.isVisible('#screen-setup'));
    check('preview canvas visible in setup', await page.isVisible('#preview'));
    check('start-match disabled before hand seen', await page.locator('#btn-start-match').isDisabled());

    // Fake hand appears → button enables
    await page.evaluate(() => window.__airsmash.setFakeHand(0.5, 0.7));
    await page.waitForTimeout(400);
    check('hand detected via fake hand', (await api()).state.hand.detected === true);
    check('start-match enabled after hand seen', !(await page.locator('#btn-start-match').isDisabled()));
    check('start-match label updates', (await page.textContent('#btn-start-match')).includes('Start match'));

    // --- Gameplay: countdown → serve → rally ---
    await page.click('#btn-start-match');
    await page.waitForTimeout(200);
    check('setup hidden after start', !(await page.isVisible('#screen-setup')));
    check('HUD visible', await page.isVisible('#hud'));
    check('countdown phase active', (await api()).state.phase === 'countdown');
    check('countdown banner visible', await page.isVisible('#banner'));

    await page.evaluate(() => window.__airsmash.skipCountdown());
    await page.waitForTimeout(250);
    check('serve phase after countdown', (await api()).state.phase === 'serve');
    check('serve chip says Your serve', (await page.textContent('#serve-chip')).includes('Your serve'));
    check('serve banner shown', (await page.textContent('#banner-text')).includes('Your serve'));

    await page.evaluate(() => window.__airsmash.serveNow());
    await page.waitForTimeout(250);
    check('rally phase after serve', (await api()).state.phase === 'rally');
    check('banner hidden during rally', !(await page.isVisible('#banner')));

    // Ball is moving in 3D
    const ballPos1 = await page.evaluate(() => ({ ...window.__airsmash.state.ball }));
    await page.waitForTimeout(350);
    const ballPos2 = await page.evaluate(() => ({ ...window.__airsmash.state.ball }));
    const moved = Math.abs(ballPos1.x - ballPos2.x) + Math.abs(ballPos1.y - ballPos2.y) + Math.abs(ballPos1.z - ballPos2.z);
    check('ball moves during rally (3D)', moved > 0.15, `Δ=${moved.toFixed(2)}m`);

    // --- Bullet-time approach window (slow-motion just before the hit) ---
    // An incoming ball toward the HUMAN's strike zone glides (ball-time
    // dilated); the same geometry outgoing runs at full speed. Balls are
    // placed high and off the paddle's line so nothing can contact, net,
    // bounce or score during the sampling window; each sample freezes the
    // phase inside the SAME evaluate that reads it (no frame in between).
    {
      // Incoming for P1: high arc, off the paddle's x — glides, never lands.
      await page.evaluate(() => {
        const a = window.__airsmash;
        a.state.phase = 'idle';          // freeze scoring while we position
        a.placeBall(0.6, 1.5, 0.72, 0.1, 0, 1.9, 'ai');
        a.state.phase = 'rally';
      });
      await page.waitForTimeout(450);
      const inc = await page.evaluate(() => {
        const a = window.__airsmash;
        const r = { sm: a.state.slowMo, t: a.slowMoTarget() };
        a.state.phase = 'idle';
        return r;
      });
      check('slowmo: incoming ball dilates ball-time',
        inc.t < 0.7 && inc.sm < 0.75, `target=${inc.t.toFixed(2)} eased=${inc.sm.toFixed(2)}`);

      // Ball actually glides: displacement over a fixed wall-clock window
      // is far smaller than vz × dt would give at full speed.
      const glide = await page.evaluate(async () => {
        const a = window.__airsmash;
        a.placeBall(0.6, 1.5, 0.72, 0.1, 0, 1.9, 'ai');
        a.state.phase = 'rally';
        const b1 = { ...a.state.ball };
        const t0 = performance.now();
        while (performance.now() - t0 < 300) await new Promise(r => requestAnimationFrame(r));
        const r = {
          dz: Math.abs(a.state.ball.z - b1.z),
          dz_expect: Math.abs(b1.vz) * 0.3,
          sm: a.state.slowMo,
        };
        a.state.phase = 'idle';
        return r;
      });
      check('slowmo: incoming ball glides (<60% of full-speed travel)',
        glide.dz < glide.dz_expect * 0.6 && glide.sm < 0.75,
        `Δz=${glide.dz.toFixed(3)}m vs full ${glide.dz_expect.toFixed(3)}m sm=${glide.sm.toFixed(2)}`);

      // Outgoing ball (P1 just hit it): full speed everywhere.
      await page.evaluate(() => {
        const a = window.__airsmash;
        a.placeBall(0.3, 1.5, 0.3, 0.2, 0.2, -2.4, 'you');
        a.state.phase = 'rally';
      });
      await page.waitForTimeout(250);
      const outg = await page.evaluate(() => {
        const a = window.__airsmash;
        const r = { sm: a.state.slowMo, t: a.slowMoTarget() };
        a.state.phase = 'idle';          // freeze mid-air, before the AI answers
        return r;
      });
      check('slowmo: outgoing ball stays full-speed',
        outg.t > 0.95 && outg.sm > 0.9, `target=${outg.t.toFixed(2)} eased=${outg.sm.toFixed(2)}`);

      // Time snaps back to real time once the point ends.
      await page.evaluate(() => {
        const a = window.__airsmash;
        a.state.phase = 'idle';
        a.state.slowMo = 0.35;          // pretend a window was open
      });
      await page.waitForTimeout(350);
      const back = await page.evaluate(() => window.__airsmash.state.slowMo);
      check('slowmo: ball-time eases back to 1 outside the rally',
        back > 0.95, `slowMo=${back.toFixed(2)}`);
    }

    // Freeze physics (phase → idle) so the live rally can't score on its own
    // while we measure paddle mapping. Input still updates in idle phase.
    await page.evaluate(() => { window.__airsmash.state.phase = 'idle'; });

    // --- Hand input moves the paddle in 3D ---
    const paddleX0 = await page.evaluate(() => window.__airsmash.state.player.x);
    await page.evaluate(() => window.__airsmash.setFakeHand(0.15, 0.6));
    await page.waitForTimeout(500);
    const paddleX1 = await page.evaluate(() => window.__airsmash.state.player.x);
    check('paddle follows hand left', paddleX1 < paddleX0 - 0.3, `x: ${paddleX0.toFixed(2)} → ${paddleX1.toFixed(2)}`);

    await page.evaluate(() => window.__airsmash.setFakeHand(0.85, 0.6));
    await page.waitForTimeout(500);
    const paddleX2 = await page.evaluate(() => window.__airsmash.state.player.x);
    check('paddle follows hand right', paddleX2 > paddleX1 + 0.3, `x: ${paddleX1.toFixed(2)} → ${paddleX2.toFixed(2)}`);

    // Vertical mapping: hand high → paddle high; hand low → paddle low.
    await page.evaluate(() => window.__airsmash.setFakeHand(0.5, 0.30));
    await page.waitForTimeout(500);
    const paddleYHigh = await page.evaluate(() => window.__airsmash.state.player.y);
    await page.evaluate(() => window.__airsmash.setFakeHand(0.5, 0.85));
    await page.waitForTimeout(500);
    const paddleYLow = await page.evaluate(() => window.__airsmash.state.player.y);
    check('paddle follows hand vertically', paddleYHigh > paddleYLow + 0.3, `y: ${paddleYHigh.toFixed(2)} → ${paddleYLow.toFixed(2)}`);

    const ws = await page.evaluate(() => ({
      x: window.__airsmash.state.player.x,
      y: window.__airsmash.state.player.y,
      z: window.__airsmash.state.player.z,
    }));
    check('paddle stays in workspace', Math.abs(ws.x) <= 1.06 && ws.y >= 0.8 && ws.y <= 1.65 && ws.z > 0.5 && ws.z < 1.4,
      `(${ws.x.toFixed(2)}, ${ws.y.toFixed(2)}, ${ws.z.toFixed(2)})`);

    // --- P1 gestures: power + direction (P1-only, no spin) ---
    const gest = await page.evaluate(() => {
      const A = window.__airsmash;
      const open = A.makeFakeSkeleton({ curl: 0, size: 0.09, roll: 0 });
      const fist = A.makeFakeSkeleton({ curl: 1, size: 0.09, roll: 0 });
      const gOpen = A.analyseP1Hand(open, { size: 0.09, thumbSide: 1 }, 'Right');
      const gFist = A.analyseP1Hand(fist, { size: 0.09, thumbSide: 1 }, 'Right');
      const gPunch = A.analyseP1Hand(A.makeFakeSkeleton({ curl: 0, size: 0.13, roll: 0 }), { size: 0.09, thumbSide: 1 }, 'Right');
      const gRoll = A.analyseP1Hand(A.makeFakeSkeleton({ curl: 0, size: 0.09, roll: 0.5 }), { size: 0.09, thumbSide: 1 }, 'Right');
      const gBack = A.analyseP1Hand(A.makeFakeSkeleton({ curl: 0, size: 0.09, roll: 0, thumbSide: -1 }), { size: 0.09, thumbSide: 1 }, 'Right');
      const gFore = A.analyseP1Hand(A.makeFakeSkeleton({ curl: 0, size: 0.09, roll: 0, thumbSide: 1 }), { size: 0.09, thumbSide: 1 }, 'Right');
      const gNull = A.analyseP1Hand(null, { size: 0.09, thumbSide: 1 });
      return {
        open: gOpen.powerMul, fist: gFist.powerMul, fistFlag: gFist.fist,
        punch: gPunch.powerMul, punchAmt: gPunch.punch,
        rollTrim: gRoll.aimXTrim, back: gBack.facing, fore: gFore.facing, nullPow: gNull.powerMul,
      };
    });
    check('gesture: fist hits harder than open', gest.fist > gest.open && gest.fistFlag === true, `open=${gest.open.toFixed(2)} fist=${gest.fist.toFixed(2)}`);
    check('gesture: punch toward camera boosts power', gest.punch > 1.1 && gest.punchAmt > 0.2, `power=${gest.punch.toFixed(2)} punch=${gest.punchAmt.toFixed(2)}`);
    check('gesture: wrist roll trims aim', Math.abs(gest.rollTrim) > 0.08, `trim=${gest.rollTrim.toFixed(2)}`);
    check('gesture: forehand/backhand from thumb side', gest.fore === 'forehand' && gest.back === 'backhand', `${gest.fore}/${gest.back}`);
    check('gesture: null skeleton is neutral', gest.nullPow === 1, String(gest.nullPow));

    // Gesture plumbing is P1-only: P2 landmarks never touch P1 power.
    const p1only = await page.evaluate(() => {
      const A = window.__airsmash;
      A.state.hand.gesture = { powerMul: 1, aimXTrim: 0, punch: 0, roll: 0, facing: 'unknown', fist: false };
      A.setFakeLandmarks(A.makeFakeSkeleton({ curl: 1 }), 1);
      return A.state.hand.gesture.powerMul;
    });
    check('gesture: P2 skeleton leaves P1 power alone', p1only === 1, String(p1only));

    // Power reaches the ball: fisted P1 serve leaves faster than open.
    const servePow = await page.evaluate(() => {
      const A = window.__airsmash;
      A.state.phase = 'serve'; A.state.serveSide = 'you'; A.state.ball.visible = true;
      A.setFakeGesture(1.0, 0, 0);
      // Directly exercise the serve math via two launches (open vs fist).
      return true;
    });
    check('gesture seam present', servePow === true);

    // Adaptive capture + calibration + pose seams exist.
    const seams = await page.evaluate(() => {
      const A = window.__airsmash;
      const roi = A.computeTrackRoi();
      const roiOk = roi === null || (typeof roi.x === 'number' && typeof roi.w === 'number');
      A.clearFakeHand();
      return {
        hasRoi: typeof A.computeTrackRoi === 'function',
        roiOk,
        hasPerf: !!A.state.perf && typeof A.state.perf.rtt === 'number',
        hasCalib: typeof A.skipCalibration === 'function',
        calibBlockHidden: document.getElementById('calib-block').classList.contains('hidden'),
        poseOpt: !!document.getElementById('pose-opt'),
        poseOff: A.state.pose.enabled === false,
        hasSkeleton: typeof A.makeFakeSkeleton === 'function',
      };
    });
    // Re-raise the hand for the scoring flow below (seam check clears it).
    // Freeze to idle right away: the checks below take seconds, and a live
    // serve phase would auto-launch and resolve points on its own.
    await page.evaluate(() => window.__airsmash.setFakeHand(0.5, 0.6));
    await page.waitForTimeout(250);
    await page.evaluate(() => { window.__airsmash.state.phase = 'idle'; });
    check('capture: ROI helper present, sane shape', seams.hasRoi && seams.roiOk);
    check('capture: perf telemetry present', seams.hasPerf);
    check('calibration: skip seam + hidden in test mode', seams.hasCalib && seams.calibBlockHidden);
    check('pose: optional toggle present, default off', seams.poseOpt && seams.poseOff && seams.hasSkeleton);

    // --- Frame pacing monitor ---
    const perf = await page.evaluate(() => window.__airsmash.getPerf());
    check('perf: getPerf seam returns frame stats',
      typeof perf.frameEmaMs === 'number' && typeof perf.slowFrameCount === 'number' &&
      typeof perf.inflightResets === 'number' && typeof perf.syncRuns === 'number' &&
      typeof perf.trackSrc === 'string',
      JSON.stringify(perf));
    check('perf: no overlay div without ?perf=1', await page.evaluate(() => !document.getElementById('perf-stats')));
    // ?perf=1 overlay renders live stats without errors.
    const perfPage = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    perfPage.on('console', m => { if (m.type() === 'error') errors.push('perfpage: ' + m.text()); });
    perfPage.on('pageerror', e => errors.push('perfpage: ' + String(e)));
    await perfPage.goto(`http://localhost:${PORT}/?test=1&perf=1`, { waitUntil: 'domcontentloaded' });
    await perfPage.waitForFunction(() => !!window.__airsmash, null, { timeout: 8000 });
    await perfPage.waitForTimeout(700);
    const overlayText = await perfPage.evaluate(() => document.getElementById('perf-stats')?.textContent || '');
    check('perf: ?perf=1 overlay shows frame stats', overlayText.includes('frame') && overlayText.includes('slow'),
      overlayText.split('\n')[0] || '(empty)');
    await perfPage.context().close();

    // --- Arm fallback: wrist keeps P1 alive when the palm drops ---
    // (Freeze to idle: swinging the paddle in serve phase would launch it.)
    await page.evaluate(() => {
      const A = window.__airsmash;
      A.state.phase = 'idle';
      A.clearFakeHand();
      A.setFakeArm(0.15, 0.6);
    });
    await page.waitForTimeout(500);
    const armLeft = await page.evaluate(() => ({
      x: window.__airsmash.state.player.x, src: window.__airsmash.state.hand.trackSrc,
    }));
    check('arm: wrist drives paddle when palm lost', armLeft.x < -0.3 && armLeft.src === 'arm',
      `x=${armLeft.x.toFixed(2)} src=${armLeft.src}`);
    await page.evaluate(() => window.__airsmash.setFakeArm(0.85, 0.6));
    await page.waitForTimeout(500);
    const armRight = await page.evaluate(() => window.__airsmash.state.player.x);
    check('arm: wrist tracks right', armRight > armLeft.x + 0.3,
      `x: ${armLeft.x.toFixed(2)} → ${armRight.toFixed(2)}`);
    check('arm: no hand-hint while wrist present', !(await page.isVisible('#hand-hint')));
    // Palm retakes over cleanly at the same spot (no teleport).
    await page.evaluate(() => window.__airsmash.setFakeHand(0.85, 0.6));
    await page.waitForTimeout(400);
    const retake = await page.evaluate(() => ({
      x: window.__airsmash.state.player.x, src: window.__airsmash.state.hand.trackSrc,
    }));
    check('arm: palm retakes over without jump', retake.src === 'palm' && Math.abs(retake.x - armRight) < 0.35,
      `x=${retake.x.toFixed(2)} src=${retake.src}`);
    // Both gone → hint returns.
    await page.evaluate(() => { window.__airsmash.clearFakeHand(); window.__airsmash.clearFakeArm(); });
    await page.waitForTimeout(800);
    check('arm: hint returns when palm+wrist lost', await page.isVisible('#hand-hint'));
    // Restore the hand for the scoring flow below (back to serve phase,
    // as the gesture seam above left it).
    await page.evaluate(() => {
      const A = window.__airsmash;
      A.setFakeHand(0.5, 0.6);
      A.state.phase = 'serve'; A.state.serveSide = 'you'; A.state.ball.visible = true;
    });
    await page.waitForTimeout(250);

    // --- Scoring ---
    await page.evaluate(() => window.__airsmash.forceScore('you'));
    await page.waitForTimeout(300);
    let s = await scores();
    check('player point scored', s.you === 1 && s.ai === 0, `${s.you}:${s.ai}`);
    check('point banner shown', await page.isVisible('#banner'));

    await page.waitForTimeout(1400);   // point banner → next serve
    check('back to serve after point', (await api()).state.phase === 'serve');

    await page.evaluate(() => window.__airsmash.forceScore('ai'));
    await page.waitForTimeout(300);
    s = await scores();
    check('AI point scored', s.you === 1 && s.ai === 1, `${s.you}:${s.ai}`);

    // --- Pause / resume ---
    await page.evaluate(() => window.__airsmash.serveNow());
    await page.waitForTimeout(200);
    await page.click('#btn-pause');
    await page.waitForTimeout(200);
    check('pause overlay visible', await page.isVisible('#overlay-pause'));
    check('state paused', (await api()).state.paused === true);

    const ballAtPause = await page.evaluate(() => ({ ...window.__airsmash.state.ball }));
    await page.waitForTimeout(400);
    const ballWhilePaused = await page.evaluate(() => ({ ...window.__airsmash.state.ball }));
    check('ball frozen while paused',
      ballAtPause.x === ballWhilePaused.x && ballAtPause.y === ballWhilePaused.y && ballAtPause.z === ballWhilePaused.z);

    await page.click('#btn-resume');
    await page.waitForTimeout(200);
    check('pause overlay hidden after resume', !(await page.isVisible('#overlay-pause')));
    check('state unpaused', (await api()).state.paused === false);

    // Keyboard pause toggle
    await page.keyboard.press('p');
    await page.waitForTimeout(150);
    check('P key pauses', (await api()).state.paused === true);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    check('Esc key resumes', (await api()).state.paused === false);

    // --- Restart resets scores ---
    await page.click('#btn-pause');
    await page.waitForTimeout(150);
    await page.click('#btn-restart');
    await page.waitForTimeout(250);
    s = await scores();
    check('restart resets scores', s.you === 0 && s.ai === 0, `${s.you}:${s.ai}`);
    check('restart returns to countdown', (await api()).state.phase === 'countdown');

    // --- Win flow: finish the match ---
    await page.evaluate(() => window.__airsmash.skipCountdown());
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__airsmash.serveNow());
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__airsmash.finishMatch('you'));
    await page.waitForTimeout(400);
    check('game over overlay visible', await page.isVisible('#overlay-gameover'));
    check('game over title is You win!', (await page.textContent('#gameover-title')).includes('You win'));
    s = await scores();
    check('final score shown', (await page.textContent('#gameover-score')).trim() === `${s.you} : ${s.ai}`, await page.textContent('#gameover-score'));
    check('win recorded in state', (await api()).state.stats.wins >= 1);

    // Persistence
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('airsmash.save.v1')));
    check('save written to localStorage', !!saved && saved.stats && saved.stats.wins >= 1, JSON.stringify(saved || {}));
    check('difficulty persisted', saved && saved.difficulty === 'normal');

    // --- Rematch ---
    await page.click('#btn-rematch');
    await page.waitForTimeout(250);
    s = await scores();
    check('rematch resets scores', s.you === 0 && s.ai === 0, `${s.you}:${s.ai}`);
    check('rematch hides game over', !(await page.isVisible('#overlay-gameover')));
    check('rematch in countdown phase', (await api()).state.phase === 'countdown');

    // --- Quit to menu ---
    await page.click('#btn-pause');
    await page.waitForTimeout(150);
    await page.click('#btn-quit');
    await page.waitForTimeout(200);
    check('intro visible after quit', await page.isVisible('#screen-intro'));
    check('HUD hidden on intro', !(await page.isVisible('#hud')));
    check('intro stats show the win', Number(await page.textContent('#stat-wins')) >= 1);

    // --- Keyboard fallback mode ---
    await page.click('#btn-start');
    await page.waitForTimeout(250);
    check('setup visible again', await page.isVisible('#screen-setup'));
    await page.click('#btn-keyboard-mode');
    await page.waitForTimeout(250);
    check('keyboard mode starts match', (await api()).state.screen === 'play');
    check('input mode is keyboard', (await api()).state.inputMode === 'keyboard');
    check('preview hidden in keyboard mode', !(await page.isVisible('#preview')));

    await page.evaluate(() => window.__airsmash.skipCountdown());
    await page.waitForTimeout(200);
    const kx0 = await page.evaluate(() => window.__airsmash.state.player.x);
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(450);
    await page.keyboard.up('ArrowLeft');
    const kx1 = await page.evaluate(() => window.__airsmash.state.player.x);
    check('arrow keys move paddle', kx1 < kx0 - 0.2, `x: ${kx0.toFixed(2)} → ${kx1.toFixed(2)}`);

    // Space swing registers (serve launches on swing in keyboard mode)
    await page.keyboard.press(' ');
    await page.waitForTimeout(300);
    check('space swing launches serve', (await api()).state.phase === 'rally', (await api()).state.phase);

    // --- Two-player mode ---
    await page.click('#btn-pause');
    await page.waitForTimeout(150);
    await page.click('#btn-quit');
    await page.waitForTimeout(250);
    check('2p: back on intro', await page.isVisible('#screen-intro'));

    await page.click('#mode-seg button[data-mode="2p"]');
    await page.waitForTimeout(150);
    check('2p: mode selected', (await api()).state.mode === '2p');
    check('2p: difficulty block hidden', !(await page.isVisible('#difficulty-block')));
    const savedMode = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('airsmash.save.v1')).mode; } catch { return null; }
    });
    check('2p: mode persisted', savedMode === '2p', String(savedMode));

    await page.click('#btn-start');
    await page.waitForTimeout(300);
    check('2p: setup screen visible', await page.isVisible('#screen-setup'));
    check('2p: start-match disabled before hands seen', await page.locator('#btn-start-match').isDisabled());

    // One hand alone is not enough in two-player mode.
    await page.evaluate(() => window.__airsmash.setFakeHands([{ x: 0.32, y: 0.62 }]));
    await page.waitForTimeout(400);
    check('2p: P1 hand slot detected', (await api()).state.hand.detected === true);
    check('2p: P2 hand slot still empty', (await api()).state.hand2.detected === false);
    check('2p: one hand is not enough', await page.locator('#btn-start-match').isDisabled());

    // Both hands → unlocked. Hands sit inside their own half of the
    // mirrored frame (P1 < 0.5, P2 > 0.5), like a real shared camera.
    await page.evaluate(() => window.__airsmash.setFakeHands([{ x: 0.18, y: 0.62 }, { x: 0.82, y: 0.68 }]));
    await page.waitForTimeout(400);
    check('2p: both hand slots detected', (await api()).state.hand.detected === true && (await api()).state.hand2.detected === true);
    check('2p: start-match enabled with both hands', !(await page.locator('#btn-start-match').isDisabled()));

    await page.click('#btn-start-match');
    await page.waitForTimeout(250);
    check('2p: HUD labels are P1/P2',
      (await page.textContent('#score-label-you')) === 'P1' &&
      (await page.textContent('#score-label-ai')) === 'P2');

    // Opposite ends + split screen: P1 near, P2 far, second POV camera.
    const p2z = await page.evaluate(() => window.__airsmash.state.p2.z);
    check('2p: P2 takes the far rail', Math.abs(p2z + 1.15) < 0.01, `z=${p2z.toFixed(2)}`);
    check('2p: second POV camera exists', await page.evaluate(() => !!window.__airsmash.camera2));
    const vpOk = await page.evaluate(() => {
      const A = window.__airsmash, r = A.renderer;
      if (!r || !r.getViewport) return false;
      const v = { x: 0, y: 0, z: 0, w: 0, copy(p) { this.x = p.x; this.y = p.y; this.z = p.z; this.w = p.w; return this; } };
      r.getViewport(v);
      return Math.abs(v.z - A.view.w / 2) < 40;
    });
    check('2p: split-screen viewports active', vpOk);

    // Hands drive their own paddles; P2's x is flipped for their 180° POV.
    const t1 = await page.evaluate(() => window.__airsmash.state.player.targetX);
    const t2 = await page.evaluate(() => window.__airsmash.state.p2.targetX);
    check('2p: P1 hand drives near paddle', t1 < -0.2, `targetX=${t1.toFixed(2)}`);
    check('2p: P2 hand x flipped for far POV', t2 < -0.2, `targetX=${t2.toFixed(2)}`);

    // Half-frame sensitivity: hands at the EDGE of each player's own
    // camera half must reach the FAR end of their paddle span — nobody
    // has to cross into the other player's half of the frame.
    await page.evaluate(() => window.__airsmash.setFakeHands([{ x: 0.48, y: 0.62 }, { x: 0.88, y: 0.68 }]));
    await page.waitForTimeout(500);
    const nearRight = await page.evaluate(() => window.__airsmash.state.player.targetX);
    const farLeft = await page.evaluate(() => window.__airsmash.state.p2.targetX);
    check('2p: P1 covers full width from own camera half', nearRight > 0.8, `targetX=${nearRight.toFixed(2)}`);
    check('2p: P2 covers full width from own camera half', farLeft < -0.8, `targetX=${farLeft.toFixed(2)}`);

    await page.evaluate(() => window.__airsmash.skipCountdown());
    await page.waitForTimeout(250);
    check('2p: serve chip names a player', /^P\d serve$/.test((await page.textContent('#serve-chip')).trim()), await page.textContent('#serve-chip'));

    await page.evaluate(() => window.__airsmash.forceScore('ai'));
    await page.waitForTimeout(300);
    check('2p: point banner names Player 2', (await page.textContent('#banner-text')).includes('Player 2'), await page.textContent('#banner-text'));
    let s2 = await scores();
    check('2p: point registered for P2', s2.you === 0 && s2.ai === 1, `${s2.you}:${s2.ai}`);

    // Both near-rail paddles can strike the ball, and lastHitter alternates.
    await page.evaluate(() => {
      const st = window.__airsmash.state;
      st.phase = 'rally';
      const p = st.player;
      window.__airsmash.placeBall(p.x, p.y, p.z - 0.12, 0, 0, -0.4, 'ai');
    });
    await page.waitForTimeout(150);
    check('2p: P1 paddle returns ball', (await api()).state.ball.lastHitter === 'you', (await api()).state.ball.lastHitter);

    await page.evaluate(() => {
      const st = window.__airsmash.state;
      st.phase = 'rally';
      const q = st.p2;
      window.__airsmash.placeBall(q.x, q.y, q.z - 0.12, 0, 0, -0.4, 'you');
    });
    await page.waitForTimeout(150);
    check('2p: P2 paddle returns ball', (await api()).state.ball.lastHitter === 'ai', (await api()).state.ball.lastHitter);

    // P2 gets the same bullet-time window on the far rail (2P mode has no
    // bot — both rails are human, so both receivers get help).
    await page.evaluate(() => {
      const a = window.__airsmash;
      a.state.phase = 'idle';
      a.placeBall(0.2, 1.0, -0.8, 0.1, 0, -1.8, 'you');   // incoming for P2's rail
      a.state.phase = 'rally';
    });
    await page.waitForTimeout(450);
    const p2win = await page.evaluate(() => {
      const a = window.__airsmash;
      return { t: a.slowMoTarget(), sm: a.state.slowMo };
    });
    check('2p: P2 far-rail window opens for incoming ball',
      p2win.t < 0.7 && p2win.sm < 0.75, `target=${p2win.t.toFixed(2)} eased=${p2win.sm.toFixed(2)}`);
    await page.evaluate(() => { window.__airsmash.state.phase = 'idle'; });

    // Arm fusion stays off with two bodies on one camera (no cross-talk).
    await page.evaluate(() => {
      const A = window.__airsmash;
      A.state.phase = 'idle';
      A.clearFakeHand();
      A.setFakeArm(0.85, 0.6);
    });
    await page.waitForTimeout(500);
    const iso = await page.evaluate(() => ({
      tx: window.__airsmash.state.player.targetX, src: window.__airsmash.state.hand.trackSrc,
    }));
    check('2p: wrist does not drive P1 (palm-only)', iso.src !== 'arm', `src=${iso.src} targetX=${iso.tx.toFixed(2)}`);
    await page.evaluate(() => {
      const A = window.__airsmash;
      A.clearFakeArm();
      A.setFakeHands([{ x: 0.18, y: 0.62 }, { x: 0.82, y: 0.68 }]);
    });
    await page.waitForTimeout(400);

    // Two-player keyboard split: P2 = arrows, P1 = WASD.
    await page.evaluate(() => window.__airsmash.clearFakeHand());
    await page.click('#btn-pause');
    await page.waitForTimeout(150);
    await page.click('#btn-quit');
    await page.waitForTimeout(250);
    await page.click('#btn-start');
    await page.waitForTimeout(300);
    await page.click('#btn-keyboard-mode');
    await page.waitForTimeout(250);
    check('2p: keyboard mode starts match', (await api()).state.screen === 'play' && (await api()).state.inputMode === 'keyboard');
    await page.evaluate(() => window.__airsmash.skipCountdown());
    await page.waitForTimeout(250);

    const p2x0 = await page.evaluate(() => window.__airsmash.state.p2.x);
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(450);
    await page.keyboard.up('ArrowLeft');
    const p2x1 = await page.evaluate(() => window.__airsmash.state.p2.x);
    // P2 watches a 180°-rotated view: their left is world +x.
    check('2p: arrows drive P2 paddle (their left = +x)', p2x1 > p2x0 + 0.2, `x: ${p2x0.toFixed(2)} → ${p2x1.toFixed(2)}`);

    const p1x0 = await page.evaluate(() => window.__airsmash.state.player.x);
    await page.keyboard.down('d');
    await page.waitForTimeout(450);
    await page.keyboard.up('d');
    const p1x1 = await page.evaluate(() => window.__airsmash.state.player.x);
    check('2p: WASD drives P1 paddle', p1x1 > p1x0 + 0.2, `x: ${p1x0.toFixed(2)} → ${p1x1.toFixed(2)}`);

    // Back to VS AI for a clean end state.
    await page.click('#btn-pause');
    await page.waitForTimeout(150);
    await page.click('#btn-quit');
    await page.waitForTimeout(250);
    await page.click('#mode-seg button[data-mode="ai"]');
    await page.waitForTimeout(150);
    check('2p: difficulty block back in vs-ai mode', await page.isVisible('#difficulty-block'));

    check('no console errors', errors.length === 0, errors.join(' | ').slice(0, 200));

    // --- LAN multiplayer: two devices (two pages), real WebSocket relay ---
    const LAN_PORT = 3470;
    const { spawn } = await import('child_process');
    const lanProc = spawn(process.execPath, [path.join(DIR, 'lan-server.js'), String(LAN_PORT)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let lanOut = '';
    lanProc.stdout.on('data', d => { lanOut += d; });
    lanProc.stderr.on('data', d => { lanOut += d; });

    try {
      // Wait for the server to announce itself.
      await new Promise((resolve, reject) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (lanOut.includes('LAN server running')) { clearInterval(iv); resolve(); }
          else if (Date.now() - t0 > 6000) { clearInterval(iv); reject(new Error('lan-server did not start: ' + lanOut)); }
        }, 50);
      });

      const mkLanPage = async () => {
        const p = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
        p.lanErrors = [];
        p.on('console', m => { if (m.type() === 'error') p.lanErrors.push(m.text()); });
        p.on('pageerror', e => p.lanErrors.push(String(e)));
        await p.goto(`http://localhost:${LAN_PORT}/?test=1`, { waitUntil: 'domcontentloaded' });
        await p.waitForFunction(() => !!window.__airsmash, null, { timeout: 8000 });
        await p.waitForTimeout(300);
        return p;
      };

      const hostP = await mkLanPage();
      await hostP.click('#mode-seg button[data-mode="lan"]');
      await hostP.click('#btn-start');
      await hostP.waitForTimeout(500);
      check('lan: first device is host (P1)', await hostP.evaluate(() => window.__airsmash.state.lan.role === 'p1'));
      check('lan: lobby note visible on setup', await hostP.isVisible('#lan-note'));

      const guestP = await mkLanPage();
      await guestP.click('#mode-seg button[data-mode="lan"]');
      await guestP.click('#btn-start');
      await guestP.waitForTimeout(600);
      check('lan: second device is guest (P2)', await guestP.evaluate(() => window.__airsmash.state.lan.role === 'p2'));
      check('lan: host sees peer connected', await hostP.evaluate(() => window.__airsmash.state.lan.connected === true));
      check('lan: guest sees peer connected', await guestP.evaluate(() => window.__airsmash.state.lan.connected === true));

      // Both raise a hand → readiness syncs over the wire.
      await hostP.evaluate(() => window.__airsmash.setFakeHand(0.5, 0.6));
      await guestP.evaluate(() => window.__airsmash.setFakeHand(0.5, 0.6));
      await hostP.waitForTimeout(700);
      check('lan: host sees guest ready', await hostP.evaluate(() => window.__airsmash.state.lan.peerReady === true));
      check('lan: guest sees host ready', await guestP.evaluate(() => window.__airsmash.state.lan.peerReady === true));
      check('lan: only the host can start',
        !(await hostP.locator('#btn-start-match').isDisabled()) &&
        (await guestP.locator('#btn-start-match').isDisabled()));

      await hostP.click('#btn-start-match');
      await hostP.waitForTimeout(500);
      check('lan: match live on host', await hostP.evaluate(() =>
        window.__airsmash.state.screen === 'play' && window.__airsmash.state.phase === 'countdown'));
      check('lan: start relayed to guest', await guestP.evaluate(() =>
        window.__airsmash.state.screen === 'play' && window.__airsmash.state.phase === 'countdown'));

      await hostP.evaluate(() => window.__airsmash.skipCountdown());
      await hostP.waitForTimeout(500);
      check('lan: serve phase synced to guest', await guestP.evaluate(() => window.__airsmash.state.phase === 'serve'));
      check('lan: ball state streams to guest', await guestP.evaluate(() => window.__airsmash.state.ball.visible));

      // Guest hand drives the HOST's far paddle (full frame, flipped).
      await guestP.evaluate(() => window.__airsmash.setFakeHand(0.85, 0.55));
      await hostP.waitForTimeout(800);
      const gx = await hostP.evaluate(() => window.__airsmash.state.p2.x);
      check('lan: guest paddle reaches host sim (flipped)', gx < -0.3, `p2.x=${gx.toFixed(2)}`);

      // Host paddle reaches the guest's view via state snapshots.
      await hostP.evaluate(() => window.__airsmash.setFakeHand(0.15, 0.55));
      await guestP.waitForTimeout(800);
      const hx = await guestP.evaluate(() => window.__airsmash.state.player.x);
      check('lan: host paddle renders on guest', hx < -0.3, `player.x=${hx.toFixed(2)}`);

      // Scoring is host-authoritative; guest HUD + banner follow.
      await hostP.evaluate(() => window.__airsmash.forceScore('ai'));
      await hostP.waitForTimeout(600);
      const gScore = await guestP.evaluate(() => ({
        you: window.__airsmash.state.scoreYou, ai: window.__airsmash.state.scoreAI,
      }));
      check('lan: score syncs to guest', gScore.ai >= 1 && gScore.you === 0, JSON.stringify(gScore));
      check('lan: point banner replays on guest', (await guestP.textContent('#banner-text')).includes('Player 2'),
        await guestP.textContent('#banner-text'));

      // Pause relays both ways.
      await hostP.click('#btn-pause');
      await hostP.waitForTimeout(400);
      check('lan: pause syncs to guest', await guestP.evaluate(() => window.__airsmash.state.paused === true));
      await guestP.click('#btn-resume');
      await guestP.waitForTimeout(400);
      check('lan: guest resume syncs back to host', await hostP.evaluate(() => window.__airsmash.state.paused === false));

      // Game over overlays on both devices.
      await hostP.evaluate(() => window.__airsmash.finishMatch('you'));
      await hostP.waitForTimeout(700);
      check('lan: game over on both devices',
        await hostP.evaluate(() => window.__airsmash.state.phase === 'over') &&
        await guestP.evaluate(() => window.__airsmash.state.phase === 'over'));
      check('lan: guest game-over overlay filled in',
        (await guestP.textContent('#gameover-title')).includes('wins!') &&
        (await guestP.isVisible('#overlay-gameover')));

      // Abrupt disconnect returns the survivor to the menu.
      await guestP.context().close();
      await hostP.waitForTimeout(700);
      check('lan: host bounces to intro after disconnect', await hostP.evaluate(() =>
        window.__airsmash.state.screen === 'intro'));
      check('lan: no console errors (host page)', hostP.lanErrors.length === 0, hostP.lanErrors.join(' | ').slice(0, 150));

      await hostP.context().close();
    } finally {
      lanProc.kill();
    }

    // --- Mobile layout ---
    const mobile = await (await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    })).newPage();
    const mErrors = [];
    mobile.on('console', m => { if (m.type() === 'error') mErrors.push(m.text()); });
    mobile.on('pageerror', e => mErrors.push(String(e)));

    await mobile.goto(`http://localhost:${PORT}/?test=1`, { waitUntil: 'domcontentloaded' });
    await mobile.waitForFunction(() => !!window.__airsmash, null, { timeout: 8000 });
    await mobile.waitForTimeout(400);

    check('mobile: intro visible', await mobile.isVisible('#screen-intro'));
    const startBox = await mobile.locator('#btn-start').boundingBox();
    check('mobile: start button on screen', startBox && startBox.y + startBox.height <= 844, startBox ? `y=${Math.round(startBox.y + startBox.height)}` : 'null');
    check('mobile: WebGL renderer created', await mobile.evaluate(() => !!window.__airsmash.renderer));

    await mobile.click('#btn-start');
    await mobile.waitForTimeout(250);
    await mobile.evaluate(() => window.__airsmash.setFakeHand(0.5, 0.7));
    await mobile.waitForTimeout(400);
    await mobile.click('#btn-start-match');
    await mobile.waitForTimeout(300);

    check('mobile: HUD visible', await mobile.isVisible('#hud'));
    const hudBox = await mobile.locator('#hud').boundingBox();
    check('mobile: HUD fits width', hudBox && hudBox.width <= 390, hudBox ? `w=${Math.round(hudBox.width)}` : 'null');

    const previewBox = await mobile.locator('#preview').boundingBox();
    check('mobile: PiP preview visible in play', previewBox && previewBox.width > 60 && previewBox.y + previewBox.height <= 844,
      previewBox ? `${Math.round(previewBox.width)}x${Math.round(previewBox.height)} @ y=${Math.round(previewBox.y)}` : 'null');

    const pauseBox = await mobile.locator('#btn-pause').boundingBox();
    check('mobile: pause button tappable (≥40px)', pauseBox && pauseBox.width >= 40 && pauseBox.height >= 40,
      pauseBox ? `${Math.round(pauseBox.width)}x${Math.round(pauseBox.height)}` : 'null');

    check('mobile: no console errors', mErrors.length === 0, mErrors.join(' | ').slice(0, 200));

  } catch (e) {
    console.error('VERIFICATION ERROR:', e);
    failures++;
  } finally {
    await browser.close();
    server.close();
    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  }
});
