// Captures real screenshots of the game for the README.
// Usage: node capture.js
//
// Runs against ?test=1 with a simulated camera feed + fake hand skeleton,
// so screenshots show the camera-behind-the-table look without a real camera.

import path from 'path';
import http from 'http';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '..', '..', 'Do not delete folder', '.pw-browsers');

const { chromium } = await import('playwright');

const PORT = 3459;
const DIR = __dirname;
const OUT = path.join(DIR, 'screenshots');

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

// A plausible open hand (unmirrored normalized landmark coords).
// Palm centroid ≈ (0.392, 0.69) → mirrored fake-hand position (0.608, 0.69).
const FAKE_LANDMARKS = [
  [0.380, 0.800], // 0 wrist
  [0.330, 0.740], [0.300, 0.700], [0.280, 0.660], [0.260, 0.620], // thumb
  [0.350, 0.660], [0.345, 0.600], [0.340, 0.550], [0.335, 0.510], // index
  [0.380, 0.650], [0.380, 0.580], [0.380, 0.530], [0.380, 0.490], // middle
  [0.410, 0.660], [0.415, 0.590], [0.420, 0.545], [0.425, 0.505], // ring
  [0.440, 0.680], [0.450, 0.620], [0.455, 0.580], [0.460, 0.550], // pinky
];

async function installFakeScene(page) {
  // Simulated camera feed: a soft, warm living-room blur.
  await page.evaluate(() => {
    const cv = document.createElement('canvas');
    cv.width = 640; cv.height = 480;
    const c = cv.getContext('2d');
    const g = c.createLinearGradient(0, 0, 0, 480);
    g.addColorStop(0, '#3a3f52');
    g.addColorStop(0.55, '#4a4458');
    g.addColorStop(1, '#2c2a38');
    c.fillStyle = g;
    c.fillRect(0, 0, 640, 480);
    // Window light
    const w = c.createRadialGradient(150, 90, 20, 150, 90, 260);
    w.addColorStop(0, 'rgba(255, 236, 200, 0.55)');
    w.addColorStop(1, 'rgba(255, 236, 200, 0)');
    c.fillStyle = w;
    c.fillRect(0, 0, 640, 480);
    // Furniture blobs
    c.fillStyle = 'rgba(90, 74, 66, 0.8)';
    c.fillRect(380, 260, 260, 220);
    c.fillStyle = 'rgba(70, 88, 74, 0.7)';
    c.fillRect(40, 300, 180, 180);
    c.fillStyle = 'rgba(120, 100, 80, 0.5)';
    c.fillRect(250, 330, 120, 150);
    window.__airsmash.setFakeBackground(cv);
  });
  await page.evaluate((lm) => {
    window.__airsmash.setFakeLandmarks(lm.map(([x, y]) => ({ x, y })));
    window.__airsmash.setFakeHand(0.608, 0.69);
  }, FAKE_LANDMARKS);
}

async function captureScreenshots() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 2,
  })).newPage();

  page.on('pageerror', e => console.error('PAGE ERROR:', String(e)));

  try {
    await page.goto(`http://localhost:${PORT}/?test=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__airsmash, null, { timeout: 8000 });
    await page.waitForTimeout(600);   // let fonts settle

    // 1. Intro
    await page.screenshot({ path: path.join(OUT, 'intro.png') });
    console.log('saved intro.png');

    // 2. Setup / calibration (camera preview + skeleton + paddle)
    await page.click('#btn-start');
    await page.waitForTimeout(300);
    await installFakeScene(page);
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, 'setup.png') });
    console.log('saved setup.png');

    // 3. Gameplay — mid rally, camera behind the table
    await page.click('#btn-start-match');
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__airsmash.skipCountdown());
    await page.waitForTimeout(250);
    // Place the ball mid-table with a fresh trail for a lively shot.
    await page.evaluate(() => {
      const s = window.__airsmash.state;
      const t = window.__airsmash.table;
      s.ball.x = t.x + t.w * 0.62;
      s.ball.y = t.y + t.h * 0.42;
      s.ball.vx = 180;
      s.ball.vy = 320;
      s.rally = 4;
    });
    await page.waitForTimeout(160);
    await page.screenshot({ path: path.join(OUT, 'gameplay.png') });
    console.log('saved gameplay.png');

    // 4. Pause overlay
    await page.click('#btn-pause');
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(OUT, 'pause.png') });
    console.log('saved pause.png');
    await page.click('#btn-resume');
    await page.waitForTimeout(250);

    // 5. Game over — win, with confetti
    await page.evaluate(() => window.__airsmash.finishMatch('you'));
    await page.waitForTimeout(500);   // catch confetti mid-flight
    await page.screenshot({ path: path.join(OUT, 'gameover.png') });
    console.log('saved gameover.png');

  } finally {
    await browser.close();
    server.close();
  }
}

server.listen(PORT, () => {
  captureScreenshots()
    .then(() => { console.log('DONE'); process.exit(0); })
    .catch(e => { console.error('CAPTURE ERROR:', e); process.exit(1); });
});
