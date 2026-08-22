# AirSmash 🏓

**Your hand is the paddle.** AirSmash is first-person 3D table tennis for the browser, played Kinect-style: stand in front of your camera, raise a hand, and swing through the ball to return it over the net. No controllers, no wearables — just you. Grab a friend and pick **2 Players**: two hands, two paddles, one camera.

## Screenshots

![Intro screen](screenshots/intro.png)
*The intro: pick a mode (VS AI or 2 Players), pick a difficulty, hit Start playing.*

![Setup & calibration](screenshots/setup.png)
*Setup: the arena behind, with a live camera preview and hand-skeleton overlay. Move your palm — the paddle follows.*

![Gameplay](screenshots/gameplay.png)
*First-person view from behind your end of the table: the net, the AI opponent, and the ball arcing toward your paddle.*

![Two players](screenshots/twoplayers.png)
*Two-player mode: split screen — P1's POV from the near end on the left, P2's from the far end on the right, with the camera preview split between them.*

![Paused](screenshots/pause.png)
*Pause overlay — resume, restart, or quit.*

![Game over](screenshots/gameover.png)
*Match point: confetti, final score, longest rally.*

## The Idea

Motion games died with the console generation that hosted them — but every laptop and phone already has the one sensor they needed: a camera. AirSmash brings the pick-up-and-play joy of arcade table tennis (think Table Tennis Touch) to any modern browser, in full 3D, with hand tracking that runs **entirely on your device**.

## The View

- **First-person, behind the table** — the camera sits slightly above and behind your end. You see the full length of the table, the net, and your opponent on the far side, in a neon-lit arena.
- **Floating paddle** — no player model on your side; your paddle floats near the bottom of the screen and tracks your palm in 3D.
- **Picture-in-picture camera preview** — a small mirrored feed with your hand skeleton, so you can see what the tracker sees (big and centered during calibration, tucked into a corner during play).

## How to Play

1. **Start playing**, pick a mode, and allow camera access.
2. **Raise your hand** (both hands in 2-player mode), palm toward the camera. When you see it in the preview, hit **Start match**.
3. **Move your hand** left/right and up/down — the paddle mirrors you in 3D. In 2-player you face each other across the net: P1's POV fills the left half of the screen, P2's the right, and each hand drives its own paddle.
4. **Swing through the ball** to return it. Your swing speed adds power; your swing direction steers the shot. After a serve or return, the *other* player must hit it back.
5. **Your serve**: the ball floats beside your paddle — swipe through it to launch.
6. **First to 11 wins** (win by 2; sudden death at 15). Serve alternates every 2 points.

Real-ish rules: the ball must clear the net and land on the opponent's side. Miss it, let it bounce twice, or hit the net — and the point goes the other way.

## Two-Player Mode

- **Opposite ends, split screen.** P1 plays from the near end (left half of the screen), P2 from the far end (right half, rotated 180°) — you face each other across the net like real table tennis, sharing one camera and one keyboard.
- **One camera tracks both hands.** The tracker runs with `numHands: 2`; each detected hand is locked to whichever player it was nearest recently (fresh sessions: leftmost hand in the mirror view → P1). P2's x axis is flipped so moving your hand to *your* right moves *your* paddle to your right in your own view.
- **Split camera preview.** The PiP divides down the middle: P1's half of the feed (cyan skeleton, left) and P2's (orange, right), each labeled — and it straddles the seam between the two views during play.
- **Same rules as vs-AI**: serves alternate every 2 points, faults are faults, deuce just works — the scoring engine treats P2 exactly like a far-side receiver. Wins/losses stats stay a "you vs AI" record; only best rally carries over from 2P matches.
- **Keyboard fallback**: P1 = <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> + <kbd>Space</kbd>, P2 = arrow keys + <kbd>Enter</kbd> (arrow directions are relative to P2's own view).

## Performance Notes

Hand tracking is deliberately kept off the game's critical path:

- **Inference runs in a Web Worker** (`hand-worker.js`). The main thread only snapshots the camera frame (`createImageBitmap`, async + cheap) and transfers it; MediaPipe never blocks the render loop, so a slow CPU inference frame can't make the whole game judder. If workers are unavailable it falls back to the original synchronous path automatically.
- **Speed-adaptive smoothing** — slow hand movements are filtered hard (rock-steady aim) while fast swings pass through almost unfiltered, so the paddle keeps up instead of lagging a beat behind.

## Features

- **Real 3D** — Three.js arena with shadows, neon lighting, ball trail, and an AI opponent you can see across the net.
- **Real hand tracking** — MediaPipe `HandLandmarker` runs in-browser via WebAssembly/GPU (in a Web Worker). Video **never leaves your device**.
- **1P vs AI or 2-player local** — play against three AI difficulties, or share the near rail with a friend in 2 Players.
- **Motion swing controls** — paddle position *and* swing velocity are tracked; fast swings hit harder and add spin.
- **Ballistic physics** — gravity, table bounces, net collisions, and a shot solver that aims returns with net clearance.
- **Pause & resume** — button, `P`/`Esc`, and auto-pause when the tab loses focus.
- **Keyboard fallback** — arrows/WASD move the paddle, Space swings; in 2P each player gets their own keys.
- **Stats that persist** — wins, losses and best rally saved in `localStorage`.
- **Sound** — WebAudio blips pitched by ball speed, point chimes, win fanfare; mutable, persisted.
- **Mobile-ready** — fluid layout, big touch targets, safe-area support, reduced-motion respected.

## Controls

| Action | VS AI | 2 Players |
| --- | --- | --- |
| Move paddle | Move your hand (or arrows / WASD) | P1: left hand · P2: right hand (split screen) |
| Swing / serve | Swing through the ball (or <kbd>Space</kbd>) | Same — or <kbd>Space</kbd> (P1) / <kbd>Enter</kbd> (P2) |
| Pause / resume | ⏸ button, <kbd>P</kbd> or <kbd>Esc</kbd> | same |
| Sound on/off | 🔊 button | same |

## Run It

No build step — plain HTML/CSS/JS with a vendored copy of Three.js. Internet is needed on first load (the hand-tracking model loads from a CDN, then caches).

```bash
# serve the folder (any static server works), e.g.:
python3 -m http.server 8000
# then open http://localhost:8000
```

> **Camera access requires `localhost` or HTTPS.** If you deploy it, serve over HTTPS.

Tips for best tracking: good lighting, plain-ish background, hand ~30–80 cm from the camera, palm facing the lens. Big, deliberate swings return the ball best.

To regenerate the README screenshots and run the automated playthrough (Playwright + Chromium):

```bash
npm install                 # playwright (pinned to 1.45.1)
npx playwright install chromium
node capture.js             # screenshots/*.png
node verify.js              # must end with ALL CHECKS PASSED
```

## Development

No build step, no framework — plain HTML/CSS/JS with a vendored Three.js. The game logic lives in one file (`app.js`, banner-commented sections); `AGENTS.md` documents the architecture, invariants and recipes for common changes.

## License

ISC — see [LICENSE](LICENSE).

## Future Roadmap

- **Offline mode** — vendor the hand-tracking model + WASM so no CDN is needed.
- **Tournaments** — best-of-5 matches with a difficulty ladder (and a 2P bracket).
- **Paddle skins & trails** — unlockables tied to win streaks.
- **Doubles vs AI** — you + a friend on the same side against two bots.
