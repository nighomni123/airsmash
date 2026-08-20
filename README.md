# AirSmash 🏓

**Your hand is the paddle.** AirSmash is first-person 3D table tennis for the browser, played Kinect-style: stand in front of your camera, raise a hand, and swing through the ball to return it over the net. No controllers, no wearables — just you.

## Screenshots

![Intro screen](screenshots/intro.png)
*The intro: pick a difficulty, hit Start playing.*

![Setup & calibration](screenshots/setup.png)
*Setup: the arena behind, with a live camera preview and hand-skeleton overlay. Move your palm — the paddle follows.*

![Gameplay](screenshots/gameplay.png)
*First-person view from behind your end of the table: the net, the AI opponent, and the ball arcing toward your paddle.*

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

1. **Start playing** and allow camera access.
2. **Raise one hand**, palm toward the camera. When you see it in the preview, hit **Start match**.
3. **Move your hand** left/right and up/down — the paddle mirrors you in 3D at the near end of the table.
4. **Swing through the ball** to return it. Your swing speed adds power; your swing direction steers the shot.
5. **Your serve**: the ball floats beside your paddle — swipe through it to launch.
6. **First to 11 wins** (win by 2; sudden death at 15). Serve alternates every 2 points.

Real-ish rules: the ball must clear the net and land on the opponent's side. Miss it, let it bounce twice, or hit the net — and the point goes the other way.

## Features

- **Real 3D** — Three.js arena with shadows, neon lighting, ball trail, and an AI opponent you can see across the net.
- **Real hand tracking** — MediaPipe `HandLandmarker` runs in-browser via WebAssembly/GPU. Video **never leaves your device**.
- **Motion swing controls** — paddle position *and* swing velocity are tracked; fast swings hit harder and add spin.
- **Ballistic physics** — gravity, table bounces, net collisions, and a shot solver that aims returns with net clearance.
- **Three AI difficulties** — Easy, Normal, and Hard (Hard aims away from your paddle and can miss under pressure).
- **Pause & resume** — button, `P`/`Esc`, and auto-pause when the tab loses focus.
- **Keyboard fallback** — arrow keys (or WASD) move the paddle, Space swings, if there's no camera.
- **Stats that persist** — wins, losses and best rally saved in `localStorage`.
- **Sound** — WebAudio blips pitched by ball speed, point chimes, win fanfare; mutable, persisted.
- **Mobile-ready** — fluid layout, big touch targets, safe-area support, reduced-motion respected.

## Controls

| Action | Input |
| --- | --- |
| Move paddle | Move your hand (or arrow keys / WASD) |
| Swing / serve | Swing through the ball (or <kbd>Space</kbd>) |
| Pause / resume | ⏸ button, <kbd>P</kbd> or <kbd>Esc</kbd> |
| Sound on/off | 🔊 button |

## Run It

No build step — plain HTML/CSS/JS with a vendored copy of Three.js. Internet is needed on first load (the hand-tracking model loads from a CDN, then caches).

```bash
# serve the folder (any static server works), e.g.:
python3 -m http.server 8000
# then open http://localhost:8000
```

> **Camera access requires `localhost` or HTTPS.** If you deploy it, serve over HTTPS.

Tips for best tracking: good lighting, plain-ish background, hand ~30–80 cm from the camera, palm facing the lens. Big, deliberate swings return the ball best.

To regenerate the README screenshots and run the automated playthrough (workspace-local Playwright + Chromium):

```bash
node capture.js   # screenshots/*.png
node verify.js    # must end with ALL CHECKS PASSED
```

## Future Roadmap

- **2-player mode** — two people, one camera, one hand each.
- **Offline mode** — vendor the hand-tracking model + WASM so no CDN is needed.
- **Tournaments** — best-of-5 matches with a difficulty ladder.
- **Paddle skins & trails** — unlockables tied to win streaks.
