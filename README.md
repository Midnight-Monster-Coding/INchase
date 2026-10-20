<div align="center">

# INchase

**A fast, free arcade survival game for your browser. Dash, graze, chain combos, survive.**

[▶ Play now](https://inchase.web.app/) · Developed by **IAB**

</div>

---

## About

**INchase** is a wave-based arcade survival game with a retro hardware look and neo-brutalist style. Steer your core, grab the green targets, dodge the red drones and push your combo multiplier as high as it will go. It runs in any modern browser, installs as a PWA, and works with mouse, keyboard or touch.

## Game modes

| Mode       | What it is                                                                                                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ARCADE** | The classic endless mode. Counts toward the global leaderboard.                                                                                                                                                                                    |
| **BLITZ**  | A 90 second timed run. Every wave brings a new twist (Seeker Swarm, Drifter Rain, Spike Field, Moving Prism, Weaver Wave, Titan Wave) and every 5th wave adds a boss drone. Keeps its own best score on your device and is not on the leaderboard. |

## How to play

- **Green targets**: touch them for 100 points × your multiplier. Each green raises the multiplier by 1, up to ×8. If the combo ring runs out, the multiplier resets. A shield hit halves it.
- **Dash**: costs 25 points, refunded if you break a drone. A miss costs one multiplier step.
- **Red drones**: a hit costs one shield. You start with 2 shield rings and they refill every new wave. A hit with no ring left ends the run. A red marker warns you 0.6 seconds before a drone appears.
- **Shards**: broken drones drop gold shards worth +15 points (never multiplied).
- **Graze**: skim close to a red drone without touching it for +10 points, up to 3 times per drone.
- **Ghost Drive**: charges from greens, grazes and broken drones. Activate it when full.
- **Last Chance**: at 0 shields, time slows once per wave when a drone is about to hit you.

## Controls

| Action      | Desktop                     | Mobile                                         |
| ----------- | --------------------------- | ---------------------------------------------- |
| Move        | Mouse, `WASD` or arrow keys | Virtual joystick (switchable to arrow buttons) |
| Dash        | `Space` or click            | DASH button                                    |
| Ghost Drive | `E` or wheel click          | GHOST button                                   |
| Pause       | `P`                         | PAUSE button                                   |

## Features

- Two modes: endless Arcade and 90 second Blitz
- Global leaderboard with live online count (Arcade)
- Login with Google, email and password, or email link, or just play as a guest
- Match history and personal best on every device
- Synthesized retro audio, CRT scanline toggle, dark and bright themes
- Installable PWA, responsive on phone, tablet and desktop

## Tech stack

- Vanilla JavaScript and HTML5 Canvas
- Tailwind CSS (CDN) with custom neo-brutalist styling
- Firebase Authentication and Cloud Firestore
- Firebase Hosting

## Run locally

```bash
git clone https://github.com/Midnight-Monster-Coding/inchase.git
cd inchase

# serve the folder with any static server, for example:
npx serve .
```

To use login and the leaderboard, add your own Firebase project config in `firebase-config.js`.

## Project structure

```
index.html          game page, UI and game loop
auth.js             login, leaderboard and player cards
firebase-config.js  Firebase project config
manifest.json       PWA manifest
```

## More by IAB

| Project                                                 | Description                                                                                   |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [DarkBeats](https://darkbeatsbyiab.web.app/)            | Free music streaming with unlimited music and AI mood playlists. Also on the Microsoft Store. |
| [Shutter Soul](https://shutter-soul.web.app/index.html) | A photo-only social app with ratings and chat.                                                |
| [BeatSense](https://beatsense-by-iab.web.app/)          | Shazam-style music recognition in your browser.                                               |

Learn more about the developer: [About IAB](https://darkbeatsbyiab.web.app/about/)

## License

All rights reserved © IAB. Add a `LICENSE` file if you want to open the code up.
