# Orchid Signal

A live, full-screen visualizer for the Orchid rig. It shows what's playing in **Orchid Studio**, what the **orchid-robot** arms are doing, and what **Hermes Agent** is thinking. It also shows how fast the model is answering on **Nebius Token Factory**.

The server has no dependencies and needs only Node 22.5+, since it uses the built-in `node:sqlite` and `fetch`. The front end has no build step.

```bash
npm start            # or: node server/index.mjs
```

Open <http://127.0.0.1:4747/> and press **F** for fullscreen.

| Key | Action |
| --- | --- |
| `D` | Demo mode. Synthesizes a jam so the visuals run without anything playing; uses Studio's loaded beat if there is one. Also `?demo` |
| `F` | Fullscreen |
| `T` | Trippy++. Longer trails, faster swirl, hue shifts on the snare |
| `1`–`4` | Switch look: Orbit, Warp, Ridgelines, Mandala |
| `Shift`+`1`–`4` | Switch theme: Nebula, Glass Foundry, Inference Terminal, Signal |
| `V` | Stop the video that's on screen |
| `S` | Open settings (<http://127.0.0.1:4747/settings>), also the cog in the top-right corner |

## What's on screen

- **Orbit** (center): a radial drum machine with one revolution per bar and one ring per lane.
  - Accents (velocity ≥ 0.75) are diamonds. The outer arc is the 12-bar arrangement. The spectrum ring lights up where each hit lands.
  - Inside is a chromatic pitch circle. Orchid key presses draw their chord as a polygon, loop-layer notes pulse in their layer color, and the robot's target key is ringed in pink.
- **Drum machine**: the current bar's 16-step grid per lane, labeled with each lane's sample name (e.g. *FM Compressed Kick*), plus an arrangement density strip.
- **Sequencer · loop layers**: Studio's four loop layers as a piano roll with the playhead, record state and the full Pistil sound name per layer.
  - Names come from Studio's `sounds-list`, so slot `Sound 045` shows as *Basement*.
  - ◉ marks the voice the hardware Sound dial controls.
  - The orbit's lower-left corner lists all six voices (L1–L4, Live, Play Along).
- **Orchid**: one-octave keyboard, chord bank (Dim … 9), and the voicing dial. Fed by Studio's key monitor.
- **SO101 arms**: a holographic 3D twin of the rig. Both arms are built from the official SO101 model, sitting on the Nebius Orchid plate around the Orchid, and they move with orchid-robot's live joint angles. Parts glow at their edges, motors turn orange as they heat up, a scan band sweeps up the rig and each fingertip leaves a trail. The Orchid's keys and chord buttons are placed from the arms' taught press points, so they line up with where the arms actually press. They light up when pressed, by the robot or by a person, with a ripple where the fingertip lands and the note or chord floating up. The camera orbits slowly and leans toward whichever arm is playing. If WebGL isn't available, it falls back to a 2D side view.
- **Token Factory**: the Nebius Token Factory logo, the selected model, then one large stat per row:
  - Output tok/s (the headline). When the agent hasn't run for 10+ minutes it dims and says when it last ran.
  - An activity graph: tokens generated per 2 minutes over the last 2 hours, across all of Hermes' calls. It's flat when the agent is idle.
  - Time to first token and average latency.
  - Tokens this session, the same total Hermes keeps (prompt tokens incl. cached + output). The caption shows calls, cost, cached and output tokens.
  - Tokens over the last 30 days: every session and task, including background work like reviews and titles.
  - Context remaining, for the same session and with the same numbers as Hermes' status bar. The panel follows the running Hermes CLI session, or the most recent session when no CLI is running. "Used" is computed the way Hermes's status bar does it: the current turn's first response (prompt plus completion) plus a rough estimate of the messages added since. Background memory-review turns are skipped. The total is the context length Hermes itself uses (1,000,000 for DeepSeek V4.1 Flash), taken from the stream hook or from Hermes's compression telemetry and remembered in `data/hermes-context.json`. models.dev is used only until one of those has reported it. See `server/context.mjs`.

  Type sizes scale with the panel, so every row fits from 720p up.
- **Hermes**: two boxes in the right column.
  - **WhatsApp** has its own box on top: incoming messages in mint, Hermes' replies in lime, with WhatsApp `*bold*`/`_italic_` formatting. It has its own history, so busy CLI sessions can't scroll it away, and a new incoming message streams its letters into the orbit. Telegram, Signal, Slack and other gateway platforms render the same way.
  - The **reasoning trace** has its own box below: new thinking types out at the measured token speed. Tool calls appear as chips, followed by their results.

The shader background reacts to the groove: kick zoom-punch, snare warp, hat sparkle, note hue, agent "thinking" glitter.

## Looks

The centre stage has four treatments. All of them are driven by the same live data and freeze when Studio pauses.

| Look | What it shows |
| --- | --- |
| **Orbit** | A radial drum machine with one revolution per bar and one ring per lane, plus a chromatic pitch circle that draws each chord as a shape. |
| **Warp** | A hyperspace tunnel with one ring per beat. Upcoming drum hits sit down the tunnel at their real distance in beats, so each one reaches you as it sounds. Loop notes ride an inner ring by pitch, and stars streak with the tempo. |
| **Ridgelines** | Pulsar-plot lines, one per 16th note: kick in the centre, snare either side, hats as fine spikes, notes placed by pitch. The stack scrolls back into the distance. |
| **Mandala** | The current bar folded into an 8-way kaleidoscope. Lanes bloom as petals, each chord draws its own spirograph (shaped by its intervals), and the whole thing turns a notch each bar. |

By default the looks **loop**: each plays for 1 minute, then crossfades to the next. Change this in **Settings → Visualization** with the "Loop through all four looks" switch and the "Each look plays for" slider (15 s to 30 min). The loop follows the wall clock, so every screen in a booth switches together.

To stay on one look, turn the loop off and pick it, or press `1`–`4` on the display. Picking a look from the dock also stops the loop, and its ↻ button turns the loop back on with the interval you chose.

## Themes

Themes restyle the whole display: palette, type, panel shapes, layout and the background shader. They're built loosely on the Nebius Token Factory brand guidelines:

- **Palette:** Lime `#DAFF33`, Violet `#5D52F6`, Deep Blue `#052B42`, Lavender `#C1C1FF`, Light Blue `#F0F8FF`, plus the lime → cyan → periwinkle gradient.
- **Imagery:** glass cubes, the `>_` prompt over a pixel floor, and the billboard.

| Theme | Look |
| --- | --- |
| **Nebula** | The original: deep-space kaleidoscope shader, monospace type, corner-ticked panels. |
| **Glass Foundry** | Frosted glass slabs with glossy highlights, over a tilted wall of glass cubes. A lit band climbs the wall one step per beat; the kick lifts the centre and hats sparkle single cubes. Wide Unbounded display type with gradient numerals. |
| **Inference Terminal** | Phosphor CRT: square windows with inverse-video `>_` title bars, VT323 pixel type, scanlines, glow and flicker. A pixel-grid floor rushes toward you at the tempo, and the kick flashes the near rows. Trace and chat read like a console. |
| **Signal** | The billboard. A gradient-filled pill banner carries the live tok/s and the now-playing beat in huge wide type, and sweeps light on each kick. Panels are gradient-outlined modules (the "linear" logo style), over slow aurora ribbons in the brand gradient. |

- **Switching:** pick a theme in **Settings → Theme**, or press `Shift`+`1`–`4`. Themes crossfade.
- **Rotation:** themes can rotate every N minutes, independently of the looks, and all screens switch together.
- **Logo:** every theme uses the official stacked lockup (`public/brand/lockup-*.png`), extracted from the guidelines PDF with clean transparency. On dark backgrounds its navy blocks get the guideline outline treatment. It's never recoloured, reordered, rotated or shown below ~150px.

## On-screen controls

Move the mouse and a control dock fades in at the bottom of the screen. It disappears, along with the cursor, after a few idle seconds, so the booth screen stays clean.

- **Buttons:** one per look and one per theme, a ↻ rotate toggle for each group, Demo, Fullscreen and Status.
- **Saving:** choices are saved and every open screen follows them.
- **Rotation:** picking a look or theme stops that group's rotation. Turning rotation on keeps the current one on screen until the next step.

## Connectivity takeovers

When a critical connection drops, every screen shows a full-screen red takeover. It names what's lost, how long ago, and what to check. The takeover sits above everything, videos included. It covers:

| Lost | Detected by |
| --- | --- |
| Orchid Studio | Studio's API not answering |
| The Orchid | Studio reports its USB MIDI input disconnected or stale |
| orchid-robot | no robot console on its port |
| An arm | arm not connected or in fault (hardware mode only) |
| Hermes Agent | state unreadable, or the messaging gateway not running |
| WhatsApp | gateway reports WhatsApp not connected |

How it behaves:

- **Debounce:** a problem must last 4 seconds before it shows, so a single dropped poll never flashes the screen.
- **Recovery:** when everything returns, a green "all connections restored" banner flashes.
- **Snooze:** pause takeovers for 5 or 30 minutes on all screens. **Settings → Connectivity alerts** can resume them early, turn takeovers off entirely, or mute any one system, for example when you're running without the robot.
- **Demo mode:** takeovers are hidden, since things are offline on purpose.
- **Status page:** the Orchid Signal card shows whether alerts are on, snoozed or muted.

## Diagnostic tips

Every connectivity takeover and every failing check on the status page comes with numbered "try this" steps. Commands are click-to-copy, and console and status links open in a new tab. The tips use this machine's real paths and ports. For example, they start Studio with `scripts/start-macos.sh --sound-input Orchid --chord-channel 3`, and the robot with `app.py --enable-hardware --port 8081` from the `orchid` virtualenv.

Where the error says more, the tips follow it:

- An arm stopped by "Operator connection lost" points at the closed console tab or a sleeping Mac.
- An arm stopped by a motor-worker failure points at power and USB.
- A stale Orchid gets "press a key", while a missing one gets "replug".

If the apps live elsewhere, override the paths with `--studio-dir`, `--robot-dir` and `--robot-python`. The tips themselves are in `server/tips.mjs`.

## Status page

<http://127.0.0.1:4747/status> (also linked from Settings) shows a single verdict ("All systems go" / "needs attention" / "something is down") and one card per system. Each card lists named checks. It refreshes every 2 seconds, and the tab title shows ● ▲ ✕ so you can spot it from another tab.

- **Orchid Studio:**
  - API reachable, with its latency
  - Orchid instrument over USB MIDI
  - key monitor
  - Pistil sound engine
  - Play Along
  - Sound-dial follow
  - looper and MIDI clock errors
  - transport
- **orchid-robot:**
  - console reachable (and which port)
  - simulation vs hardware
  - per arm: connected, calibrated, faults, control worker, motor temperature, joint limits
- **Hermes Agent:**
  - state database
  - messaging gateway process
  - WhatsApp connection (including "needs attention")
  - Token Factory call rate and latency
  - errors and warnings in the last hour, with the latest few (redacted)
  - the stream hook
- **Orchid Signal:** connected screens, video schedule, theme and look.

The data comes from `GET /api/health`. It's read-only like everything else. The gateway's command line is never exposed, because it can carry credentials.

## Updates reach open screens automatically

The server watches `public/`. When any file changes (or the server restarts with new code), every open display reloads itself within a few seconds. So a booth screen never keeps running stale code.

## Offline

Everything the display needs is local: fonts are bundled in `public/fonts/` (latin + latin-ext, ~400 KB, SIL OFL licenses in `public/fonts/licenses/`), and so are the brand assets and scripts. The 3D arm view uses three.js (`public/vendor/three/`, MIT) and a ~460 KB model built from the official SO101 meshes (`vendor/so101/`, Apache-2.0) and the Orchid plate STL. After changing anything in `vendor/`, rebuild it with `npm run build:rig`. The Orchid is modelled as the real ORC-1 sitting in the plate pocket. Its shape comes from Telepathic Instruments' product photos and its size from orchid-robot's measurements: chord buttons in two rows on the left, the voicing dials, one octave of keys on the right, a sloped strip of knobs with the OLED behind, and a top with speaker slots. Each arm's joint zeros come from a hand-centred calibration, so its model can be about 2 cm off. `build-rig.mjs` fits a few degrees of joint-zero correction per arm so its taught presses (`vendor/taught-presses.json`, measured with the key bottomed out) land on the right keys at the pressed height. Those corrections are applied to both the live and demo arms. After re-teaching keys or chord buttons, refresh the poses and refit the corrections (read-only) with `npm run build:rig -- --robot ~/workspace/orchid-robot`. The booth machine needs no internet connection; only Hermes needs one, to reach Token Factory.

## Staying in sync with Studio

The visualizer mirrors Studio's transport. It reads Studio's own fields (`tempo.running`, `tempo.paused`, the looper's count-in) and never decides on its own whether music is playing.

| Studio | Visualizer |
| --- | --- |
| playing | The beat is projected forward between 125 ms polls and pulled back toward each polled position. Hits fire as the playhead crosses them. |
| paused | Everything holds at Studio's exact paused position, with a blinking playhead and "❚❚ PAUSED IN STUDIO". No hits fire, the background dims, and ambient motion slows to a drift. |
| stopped | Playheads clear. |
| no fresh status for 1.5 s | "no signal". The visualizer freezes rather than guessing, so a dropped connection never looks like music. |

Drum hits only animate when Studio's drums are on and the drums fader is above zero. Loop notes skip muted or silent layers. `node --test tests/` covers these cases.

## Data sources (all read-only)

| Source | How | Notes |
| --- | --- | --- |
| Orchid Studio `127.0.0.1:8765` | `GET /status` at 8 Hz; `key-events` / `events` commands | Studio rejects cross-origin browsers, so the server proxies it. The playhead is extrapolated from `tempo.beat` + BPM between polls. |
| orchid-robot | `GET /api/state?arm=a\|b` at 4 Hz, probing ports 8081 → 8080 → 8090 | Never sends a heartbeat or reads the operator token, so it never takes the arm lease. Use `--robot-port` to pin a port. |
| Hermes `~/.hermes/state.db` | read-only SQLite (WAL) | Gives reasoning, tool calls, session token totals, and the messages behind the context-used estimate (fallback: `model_config._usage_anchor`). |
| Hermes `~/.hermes/logs/agent.log` | tailed | Gives the `API call #N` lines: model, provider, in/out tokens, latency, cache. |
| `~/.hermes/models_dev_cache.json` | read | Gives $/token, and the context window until Hermes's own is known. |

Options:

```bash
node server/index.mjs --port 4747 --studio-port 8765 --robot-port 8081 --hermes-home ~/.hermes
```

The server binds `127.0.0.1` only and checks `Host`, because the stream includes your local agent transcripts.

## Secrets and credentials

All text is redacted **on the server** (`server/redact.mjs`) before it is sent, so unredacted values never reach a browser. This covers Hermes messages, reasoning, tool arguments and output, session titles, robot messages, and stream-hook deltas. Redaction runs before display clipping, so a secret cut at the clip boundary can't slip through.

What it catches:

- **Assignments:** `KEY=…`, `key: …`, `"token": "…"`, `{'password': …}` and HTTP headers, when the key name is sensitive: api_key, secret, token, password, auth, cookie, `X-Orchid-Token`, signature, …
- **Auth and flags:** `Bearer …` / `Basic …`, and CLI flags like `--token …`.
- **Known key formats:** OpenAI/Anthropic `sk-…`, GitHub, Slack, AWS, Google, Hugging Face, NVIDIA, Nebius-style `v1.…`, JWTs, and PEM private keys.
- **Embedded credentials:** credentials in URLs (`scheme://user:pass@`).
- **Unlabeled keys:** long random-looking strings that mix upper case, lower case and digits. Git SHAs and request ids are lowercase hex, so they're left alone.
- **Phone numbers:** WhatsApp JIDs, `*_ALLOWED_USERS` lists and `+E.164` numbers are masked. The chat text stays visible.

Live stream deltas go through a hold-back redactor. It doesn't release a trailing partial word or a dangling `KEY=` until the next chunk arrives, so a secret split across chunks is still caught.

Studio events are filtered to a whitelist of fields. The robot reader never requests `/api/session`, which hands out the operator token. Hermes' own `auth.json` and `.env` are never read.

Tests: `node --test tests/`. Redaction is pattern-based, so treat it as a strong safety net, not a guarantee. If you put this on a big screen, check the trace before going live.

### About the tok/s numbers

- **Output tok/s (headline)** is always Hermes' own status-bar figure: total output tokens ÷ total latency over the current session's last 10 API calls, from Token Factory's real token counts. It's end-to-end, so it includes prompt processing and time to first token, and it matches Hermes.
  - While Hermes is streaming, the caption says "streaming now", but the number doesn't switch to a live estimate.
  - A live rate built from streamed text isn't reliable: tool-call tokens never appear in the text stream (one measured call streamed just 1.5 characters per token), and output arrives in bursts.
- **Time to first token** needs first-token timing, which only the stream hook below provides. Without the hook, it's estimated with a least-squares fit over the last 40 calls (`latency ≈ overhead + out / decode_rate`), using the fit's intercept, and marked **est**.
- `tests/factory.test.mjs` pins the headline to Hermes' formula.

## Videos between the visuals

Open **Settings** (`S`, or <http://127.0.0.1:4747/settings>).

- **Adding videos:** drop in video files, or copy them straight into `media/`. Supported formats are mp4, mov, webm, m4v, ogv and mkv.
- **Per-video options:**
  - how often it plays (every N minutes)
  - whether to play the whole video or only the first N seconds (shorter videos loop)
  - where to start in the file
  - sound level (videos are muted by default, since Studio is making the music)
- **Schedule options:**
  - the transition: **Iris** (opens from the orbit's center), **Crossfade**, or **Glitch**
  - transition length
  - whether videos may play any time, only while Studio isn't playing, or only while it is
  - whether to keep a now-playing bar (beat, BPM, Studio state, tok/s) over the video
- **Saving and playing:** changes save immediately to `data/settings.json`. **Play now** starts a video on every open visualizer.

The server runs the schedule. When several videos are due at once, the most overdue one plays first, and nothing interrupts a video already on screen. If a video stalls or its file has no length information, a backstop timer and a stall watchdog still hand back to the visualizer. While a video fully covers the screen, the visualizer stops drawing to save GPU.

## Hermes plugin: any user, exact stats, full trace

`hermes-plugin/orchid_viz` is a Hermes observer plugin. It batches events and POSTs them to the visualizer on this machine (`127.0.0.1:4747/hermes/hook`). It sends:

- **Live stream:** text and reasoning deltas, so the trace types as Hermes thinks.
- **Per-request timing and usage:** real TTFT, latency and tokens for every API call.
- **Finished messages:** the prompt, reasoning, replies, tool calls and tool results. With these, the reasoning trace works even when the visualizer can't read that Hermes's `state.db`, for example when Hermes is run by another macOS user who can't write it ("session will NOT be indexed").
- **Hermes's own inference statistics:** the numbers its status bar shows, read from the running agent. That covers model, context used and window, session tokens, API calls, average latency and velocity, cache hit and compressions. When these arrive they override the visualizer's own reconstruction, so the panel matches Hermes exactly. Hermes's background memory-review agent is ignored.
- **A heartbeat:** it names the local user, so the Status page shows which users' Hermes are connected.

The plugin never blocks the agent. If the visualizer isn't running, it drops events, and the visualizer redacts secrets before anything is displayed. Without the plugin, the visualizer falls back to `state.db` and `agent.log`.

**Install it for each macOS user who runs Hermes, as that user.** The installer only touches `<Hermes home>/plugins/orchid_viz` and the plugin's enabled flag, which it sets with `hermes plugins enable`. It is safe to re-run after updates:

```bash
scripts/install-hermes-plugin.sh
```

Options: `--url` sets the visualizer URL, `--home` sets the Hermes home, `--restart-gateway`, `--uninstall` and `--dry-run`. The installer checks that the visualizer is reachable. Afterwards, restart that user's Hermes CLI, and the gateway for WhatsApp, so the plugin loads. `hermes plugins doctor hermes-plugin/orchid_viz` validates it. Keep `plugins.stream_reasoning_deltas: true` in Hermes's config so reasoning streams too.

## Layout

```text
server/index.mjs     HTTP + SSE hub (replays latest state to new browsers), hook endpoint
server/studio.mjs    Orchid Studio poller
server/robot.mjs     orchid-robot poller
server/hermes.mjs    state.db + agent.log + models.dev reader
public/state.js      client state, beat clock, hit scheduling, chord detection
public/shader.js     WebGL2 nebula background
public/orbit.js      centre stage: Orbit look, particles, treatment switching
public/treatments/   Warp, Ridgelines and Mandala looks
public/deck.js       drum grid, loop layers, keyboard/chords
public/arm3d.js      SO101 3D twin (three.js): arms, plate, Orchid, camera
public/robotview.js  2D arm view, used if WebGL is unavailable
public/models/       rig.json + rig.bin, built by scripts/build-rig.mjs
public/vendor/three/ three.js 0.160 (MIT)
scripts/build-rig.mjs  builds the rig from vendor/ (npm run build:rig)
vendor/so101/        official SO101 URDF + STL meshes (TheRobotStudio/SO-ARM100, Apache-2.0)
vendor/plate/        Nebius SR101 Orchid plate v2 (STL)
vendor/taught-presses.json  taught touch/press poses the Orchid layout is fitted to
public/factory.js    Token Factory metrics
public/trace.js      Hermes reasoning trace
public/demo.js       demo-mode data generator
public/video.js      video takeovers and transitions
public/settings.*    settings page (videos, schedule, transitions)
server/media.mjs     media library, settings store, video scheduler
server/redact.mjs    secret redaction
public/theme.js      theme palettes (read live by every canvas renderer)
public/themes.css    Glass Foundry, Inference Terminal and Signal styles
public/backgrounds.js  glass-cube, pixel-floor and aurora shaders
public/status.*      status page
public/dock.js       on-screen control dock
public/alerts.js     connectivity takeover
server/health.mjs    health checks behind /api/health
server/tips.mjs      operator tips for every failure
public/tips.js       renders tips (copyable commands)
public/fonts/        bundled web fonts + licenses
public/brand/        official lockups (from the brand guidelines PDF) and marks
media/, data/        your videos and settings (git-ignored)
hermes-plugin/       Hermes observer plugin (scripts/install-hermes-plugin.sh installs it per user)
```
