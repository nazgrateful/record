# Frequency Recorder

A browser app that records your screen with its **internal audio** and/or your
**microphone (external audio)**, removes **background noise**, and **names
specific frequencies** when they show up in the audio.

## Features

- **Record my screen** in one click: the share window opens with the whole
  screen offered first, and recording starts as soon as you pick. Choose
  computer sound and/or your microphone, quality (720p, 1080p, 1440p, 4K or
  the screen's own size) and smoothness (30 or 60 fps); the mouse pointer is
  shown. Stop with ■ Stop or the browser's "Stop sharing"; it's saved in
  Saved recordings (MP4 where the browser can). Works on computers (Chrome,
  Edge, Firefox, Safari); phones and tablets can't share their screen.
  Computer (internal) sound is recorded automatically: the share window's
  audio switch is requested on; if no sound comes through, a loopback device
  (Stereo Mix, BlackHole, Loopback, VB-Cable, "Monitor of …") is used when
  present; otherwise it asks before recording without sound, with tips for
  the system. Stopping ends the screen share at once.
- **Screen + internal audio recording** with the browser's screen-share picker.
- **Microphone recording**, with or without a screen share (or audio only).
- **Background noise removal** (runs in the app, on the audio thread):
  - Spectral noise reduction that tracks the background noise automatically,
    or learns it from 2 seconds of silence ("Learn noise").
  - Low-rumble cut (80 Hz high-pass) and the browser's built-in noise
    suppression / echo cancellation for the mic.
  - Can be switched on for the mic and for internal audio separately.
- **Named frequencies**: give a frequency a name (e.g. "Alarm = 3150 Hz").
  While it's present in the audio, the name:
  - shows under "Now hearing" and is drawn onto the recorded video,
  - goes into a timestamped detection log (exportable as CSV),
  - goes into subtitle files (.vtt / .srt) saved with each recording.
  - Optionally **mutes** the recording while that frequency is present.
- **Saving without losing data**:
  - Every recording is saved on the website (in the browser's storage)
    automatically, written every second while recording. If the tab crashes
    or closes, it's recovered the next time you open the page. The app asks
    the browser to treat this storage as permanent.
  - **Download automatically** when you stop (on by default).
  - **Auto-save to a folder on your computer**, such as the Desktop
    (Chrome/Edge): choose the folder once and every recording is written
    straight into it while recording, with a .vtt subtitle file next to it.
    The browser may ask you to allow access again after a restart. In other
    browsers, auto-download saves to your Downloads folder (change the
    browser's download location to use the Desktop).
  - Any saved recording can also be downloaded with its subtitles, or deleted.
- **Separate screen and sound files**: record the screen with sound in one
  file, or the screen (no sound) and the sound as two separate files that
  start at the same moment, or just the sound, or just the screen.
- **Long recordings (12 hours and more)**: recordings stream to storage every
  second, the computer can be kept awake while recording, there's an optional
  auto-stop timer, and the storage line shows roughly how many hours fit.
  Saved recordings get their full length worked out so you can jump anywhere.
- **Sound check** before recording: 3 s of quiet then 5 s of normal sound
  through the same chain that gets recorded. It reports level, clipping,
  background noise, mains hum, rumble, DC offset and stereo problems, with
  tips and one-click fixes (mic volume, noise removal and learning, a live
  50/60 Hz hum filter, low cut, browser noise suppression).
- **Import & edit audio** (section 6): import WAV, MP3, M4A/AAC, OGG/Opus,
  WebM, MP4 or MKV (audio is taken from video files), or press **Edit** on a
  saved recording.
  - See the **whole recording** in an overview strip; drag its box or click
    to move, scroll with the wheel or scroll bar, zoom, jump to a time
    (e.g. `2:15:30`), ±10 s, and the playhead follows playback.
  - Select by dragging, then cut / copy / paste / delete / keep only
    selection / silence, with undo and redo.
  - Effects on the selection (or everything): fade in/out, normalize, change
    volume, reverse, and noise removal (optionally learned from a selection).
  - **Speed**: slow down (0.5×, 0.75×, 0.9×) or speed up (1.1×–2×, or any
    25–400%) the selection or everything, keeping the pitch (time-stretch,
    voices stay natural) or like a tape (pitch changes too). "Listen at"
    plays faster/slower without changing the audio.
  - **Street noise**: finds car horns (including two-tone horns), sirens,
    brake squeals/whistles, passing vehicles/engines and bangs/knocks, marks
    them on the waveform and lists them to listen to and tick; then cut them
    out (with a crossfade), filter them out (keeps the voice), turn them down
    or silence them, in one undoable step. Constant traffic rumble is pointed
    out with one-click fixes. It's pattern-based, so check the list first.
  - **Add frequencies**: layer tones from your named frequencies, the
    built-in library (Solfeggio, 432 Hz, planetary, Hemi-Sync…), ready-made
    binaural beats, or any Hz. For each one choose the ears: both ears at
    once, left only, right only, or a different Hz in each ear (binaural
    beat); plus wave (sine, triangle, square, sawtooth) and volume. The panel
    says exactly which sound they go into: the selection, the whole sound,
    or new audio inserted at the cursor (keeping, lowering or replacing the
    original); any saved recording has an **Add frequencies** button. Fades
    avoid clicks; preview first. **New audio from frequencies** starts from
    silence of any length (e.g. a 1-hour 432 Hz track). **Remove this
    frequency** (and optionally its harmonics) with narrow notch filters.
  - **Check audio health** finds clipping, quiet or loud audio, noise, hum,
    rumble, DC offset, one-sided or out-of-phase stereo and silent ends, and
    fixes them in one click.
  - Works on 12-hour files: decoded sound is kept in the browser's storage in
    blocks, never all in memory; it's still there after a reload.
- **Screen recordings saved and downloadable as video**: every screen
  recording is kept in Saved recordings with a Download button. New ones are
  recorded straight to **MP4** (H.264, plays on iPhone, Windows and Mac) when
  the browser can (recent Chrome/Edge, Safari), otherwise WebM. **Convert &
  download** / **Save converted copy** turns WebM screen recordings into MP4
  (H.264 where the browser can encode it; otherwise the VP9 video is copied
  into MP4 without quality loss) or WebM. **Add video or audio files** keeps
  copies of other files on the site.
- **Convert / download in other formats**: MP3, M4A (AAC, where the browser
  can encode it, e.g. Chrome on Windows/macOS), Opus in OGG or WebM, and
  WAV 16-bit, 24-bit or 32-bit float. From the editor, or **Convert &
  download** on any saved recording (its sound). The MP3 encoder and the
  WebM/MP4 muxers are loaded from jsDelivr the first time they're used.
- **Binaural-beat meter**: shows the difference between the left- and
  right-ear tones (how Robert Monroe's Hemi-Sync works), with its brainwave
  band and use.
- **Built-in frequency library** you can add with one click: beeps and test tones,
  mains hum (50/60 Hz and harmonics), alarms and emergency alert tones,
  telephone tones, DTMF keypad tones, musical tuning, near-ultrasonic tones,
  spiritual frequencies (Solfeggio, angel numbers, 432 Hz, OM and planetary
  tones, 40 Hz), Robert Monroe / Hemi-Sync example binaural pairs,
  plus a **musical note picker** (C0–B8).
- **▶ Hear any frequency**: every named frequency, built-in frequency, musical
  note and editor frequency layer has a play button (one at a time, gentle
  fades; each ear its own tone for binaural layers).
- Live spectrum and the loudest frequency right now, with its note name.
- "Play test tones" lets you try everything without sharing anything.

## Your recordings are kept across updates

Recordings, settings and audio open in the editor live in your browser's
storage for this site, and updates to the site never remove them:

- Storage changes between versions only ever add things; each update is
  checked against data saved by every earlier version (`npm run test:upgrade`).
- If a tab with the old version is still open, the new one asks you to close
  it instead of showing an empty list, and finishes updating once it's closed.
- Opening the site in another tab never touches a recording in progress.
- The site asks the browser to never clear its storage automatically.
- **Back up everything to a folder** (Chrome/Edge) copies every recording
  to a folder of your choice with an index file; doing it again only copies
  new ones. **Restore from a backup folder** puts back anything missing (for
  example after clearing browser data or on a new computer). The auto-save
  folder can be restored from the same way.

Storage belongs to the site's address: keep using the same address (for
example the same GitHub Pages URL), or back up and restore when it changes.

## Running it

The page must be served over `http://localhost` or `https://` (browsers block
screen capture and audio worklets on `file://`). From this folder:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Or publish the folder with GitHub Pages.

Use a recent Chrome or Edge for the best results. To capture internal audio,
turn on **Share audio** in the share dialog. Whole-screen system audio works
on Windows and ChromeOS; on macOS and Linux, share a browser tab to get its
audio. Firefox and Safari can't capture tab or system audio yet, but the
microphone still works there.

## Tuning detection

- **Tone strength**: how much of the sound must be at that frequency. Lower it
  to catch tones mixed under music or speech; raise it if you get false matches.
- **Minimum level**: ignore audio quieter than this.
- **Hold**: how long the name (and mute) stays on after the tone stops.
- **± Hz** on each frequency: how far off the exact frequency still counts.

## Files

- `index.html`, `style.css`, `app.js`: UI, audio graph, recording.
- `freq-guard-worklet.js`: detects the named frequencies (Goertzel algorithm)
  and handles muting.
- `denoise-worklet.js`: FFT-based background noise removal.
- `presets.js`: built-in frequency library, note helpers and brainwave bands.
- `db.js`: saved-recordings library (IndexedDB) with crash recovery.
- `editor.js`: the audio editor. `pcm.js`: block storage for long audio.
- `decoders.js`: streaming import (WAV, WebM/MKV, Ogg, MP3, MP4/M4A).
- `export.js`: conversion to MP3, M4A, Opus (OGG/WebM) and WAV, streamed.
- `tones.js`: tone / binaural-beat generator for Add frequencies.
- `video.js`: screen-recording conversion to MP4/WebM (WebCodecs + muxers).
- `stretch.js`: speed changes (time-stretch keeping pitch, and resampling).
- `street.js`: the street-noise finder.
- `health.js`: the audio health check and sound check suggestions.
- `tap-worklet.js`: hands live audio to the sound check.
- `tests/upgrade-check.mjs`: checks updates keep all saved data (`npm run test:upgrade`).

Note: the uses listed for spiritual and Hemi-Sync frequencies are the
traditional or popular claims attached to them, not scientifically established
effects. The Monroe Institute's exact per-programme tones are proprietary; the
built-in pairs are published examples.
