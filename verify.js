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
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '..', '..', 'Do not delete folder', '.pw-browsers');

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
    check('difficulty segment has 3 options', (await page.locator('#difficulty-seg button').count()) === 3);
    check('normal difficulty preselected', await page.locator('#difficulty-seg button.on').getAttribute('data-diff') === 'normal');
    check('stats row present', await page.isVisible('#intro-stats'));

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

    check('no console errors', errors.length === 0, errors.join(' | ').slice(0, 200));

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
