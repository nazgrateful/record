# Frequency Recorder

A browser app that records your screen with its **internal audio** and/or your
**microphone (external audio)**, removes **background noise**, and **names
specific frequencies** when they show up in the audio.

## Features

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
  - **Check audio health** finds clipping, quiet or loud audio, noise, hum,
    rumble, DC offset, one-sided or out-of-phase stereo and silent ends, and
    fixes them in one click.
  - Works on 12-hour files: decoded sound is kept in the browser's storage in
    blocks, never all in memory; it's still there after a reload.
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
- Live spectrum and the loudest frequency right now, with its note name.
- "Play test tones" lets you try everything without sharing anything.

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
- `health.js`: the audio health check and sound check suggestions.
- `tap-worklet.js`: hands live audio to the sound check.

Note: the uses listed for spiritual and Hemi-Sync frequencies are the
traditional or popular claims attached to them, not scientifically established
effects. The Monroe Institute's exact per-programme tones are proprietary; the
built-in pairs are published examples.
