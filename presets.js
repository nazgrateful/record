// Built-in frequencies the user can add to their watch list with one click.
// Tolerance is +/- Hz around the centre frequency.
export const PRESET_LIBRARY = [
  {
    category: 'Beeps & test tones',
    items: [
      { name: 'Censor bleep', freq: 1000, tolerance: 15 },
      { name: 'Test tone 440 Hz', freq: 440, tolerance: 6 },
      { name: 'Test tone 10 kHz', freq: 10000, tolerance: 40 },
      { name: 'Timecode / SMPTE pilot 2 kHz', freq: 2000, tolerance: 20 },
    ],
  },
  {
    category: 'Hum & electrical noise',
    items: [
      { name: 'Mains hum 50 Hz (EU/Asia)', freq: 50, tolerance: 2 },
      { name: 'Mains hum 60 Hz (US)', freq: 60, tolerance: 2 },
      { name: 'Hum harmonic 100 Hz', freq: 100, tolerance: 3 },
      { name: 'Hum harmonic 120 Hz', freq: 120, tolerance: 3 },
      { name: 'CRT / TV whine 15.7 kHz', freq: 15734, tolerance: 40 },
    ],
  },
  {
    category: 'Alarms & alerts',
    items: [
      { name: 'Smoke alarm (~3.1 kHz)', freq: 3150, tolerance: 150 },
      { name: 'Emergency alert tone A (853 Hz)', freq: 853, tolerance: 8 },
      { name: 'Emergency alert tone B (960 Hz)', freq: 960, tolerance: 8 },
      { name: 'Truck reversing beeper (~1.1 kHz)', freq: 1100, tolerance: 80 },
    ],
  },
  {
    category: 'Telephone',
    items: [
      { name: 'Dial tone low (350 Hz)', freq: 350, tolerance: 6 },
      { name: 'Dial tone high (440 Hz)', freq: 440, tolerance: 6 },
      { name: 'Busy signal low (480 Hz)', freq: 480, tolerance: 6 },
      { name: 'Busy signal high (620 Hz)', freq: 620, tolerance: 6 },
      { name: 'UK dial tone (425 Hz)', freq: 425, tolerance: 6 },
      { name: 'Fax calling tone (1100 Hz)', freq: 1100, tolerance: 10 },
      { name: 'Modem answer tone (2100 Hz)', freq: 2100, tolerance: 12 },
    ],
  },
  {
    category: 'DTMF keypad tones',
    items: [
      { name: 'DTMF row 1 (697 Hz)', freq: 697, tolerance: 8 },
      { name: 'DTMF row 2 (770 Hz)', freq: 770, tolerance: 8 },
      { name: 'DTMF row 3 (852 Hz)', freq: 852, tolerance: 8 },
      { name: 'DTMF row 4 (941 Hz)', freq: 941, tolerance: 8 },
      { name: 'DTMF col 1 (1209 Hz)', freq: 1209, tolerance: 10 },
      { name: 'DTMF col 2 (1336 Hz)', freq: 1336, tolerance: 10 },
      { name: 'DTMF col 3 (1477 Hz)', freq: 1477, tolerance: 10 },
    ],
  },
  {
    category: 'Music & tuning',
    items: [
      { name: 'Middle C (C4)', freq: 261.63, tolerance: 4 },
      { name: 'Concert A (A4)', freq: 440, tolerance: 4 },
      { name: 'Low E string (E2)', freq: 82.41, tolerance: 2 },
    ],
  },
  {
    // Traditional / popular names used in meditation and sound-healing music.
    category: 'Spiritual frequencies — Solfeggio',
    items: [
      { name: '174 Hz – Foundation / pain relief', freq: 174, tolerance: 2 },
      { name: '285 Hz – Healing & regeneration', freq: 285, tolerance: 2 },
      { name: '396 Hz – UT: Liberation from fear & guilt', freq: 396, tolerance: 2 },
      { name: '417 Hz – RE: Undoing situations, change', freq: 417, tolerance: 2 },
      { name: '528 Hz – MI: Transformation, "love frequency"', freq: 528, tolerance: 2 },
      { name: '639 Hz – FA: Connection & relationships', freq: 639, tolerance: 2 },
      { name: '741 Hz – SOL: Expression & solutions', freq: 741, tolerance: 2 },
      { name: '852 Hz – LA: Intuition, returning to spiritual order', freq: 852, tolerance: 2 },
      { name: '963 Hz – SI: Divine connection, "God frequency"', freq: 963, tolerance: 2 },
    ],
  },
  {
    category: 'Spiritual frequencies — Angel numbers',
    items: [
      { name: '111 Hz – Angel: New beginnings', freq: 111, tolerance: 2 },
      { name: '222 Hz – Angel: Balance & harmony', freq: 222, tolerance: 2 },
      { name: '333 Hz – Angel: Ascended masters', freq: 333, tolerance: 2 },
      { name: '444 Hz – Angel: Protection', freq: 444, tolerance: 2 },
      { name: '555 Hz – Angel: Change', freq: 555, tolerance: 2 },
      { name: '666 Hz – Angel: Grounding', freq: 666, tolerance: 2 },
      { name: '777 Hz – Angel: Spiritual awakening', freq: 777, tolerance: 2 },
      { name: '888 Hz – Angel: Abundance', freq: 888, tolerance: 2 },
      { name: '999 Hz – Angel: Completion', freq: 999, tolerance: 2 },
      { name: '1111 Hz – Angel: Alignment', freq: 1111, tolerance: 3 },
    ],
  },
  {
    category: 'Spiritual frequencies — Tuning, OM & planets',
    items: [
      { name: '432 Hz – "Verdi" natural tuning', freq: 432, tolerance: 2 },
      { name: '136.1 Hz – OM / Earth year (heart chakra)', freq: 136.1, tolerance: 1.5 },
      { name: '194.18 Hz – Earth day (root chakra)', freq: 194.18, tolerance: 1.5 },
      { name: '126.22 Hz – Sun (solar plexus)', freq: 126.22, tolerance: 1.5 },
      { name: '210.42 Hz – Synodic moon (sacral)', freq: 210.42, tolerance: 1.5 },
      { name: '141.27 Hz – Mercury', freq: 141.27, tolerance: 1.5 },
      { name: '221.23 Hz – Venus', freq: 221.23, tolerance: 1.5 },
      { name: '144.72 Hz – Mars', freq: 144.72, tolerance: 1.5 },
      { name: '183.58 Hz – Jupiter', freq: 183.58, tolerance: 1.5 },
      { name: '147.85 Hz – Saturn', freq: 147.85, tolerance: 1.5 },
      { name: '40 Hz – Gamma brainwave tone', freq: 40, tolerance: 1.5 },
    ],
  },
  {
    // Hemi-Sync uses binaural beats: a different tone in each ear; the brain
    // hears the difference. The Monroe Institute's exact per-programme tones
    // are proprietary; these are the published example pairs. Use the
    // binaural-beat meter to read the beat of any track.
    category: 'Robert Monroe / Hemi-Sync (binaural pairs)',
    items: [
      { name: 'Hemi-Sync carrier 100 Hz (left ear of the 4 Hz & 7 Hz pairs)', freq: 100, tolerance: 1 },
      { name: 'Hemi-Sync 104 Hz (with 100 Hz → 4 Hz beat: Focus 10, "mind awake, body asleep")', freq: 104, tolerance: 1 },
      { name: 'Hemi-Sync 107 Hz (with 100 Hz → 7 Hz theta beat: deep meditation, REM)', freq: 107, tolerance: 1 },
      { name: 'Hemi-Sync carrier 300 Hz (left ear of the 10 Hz pair)', freq: 300, tolerance: 1.5 },
      { name: 'Hemi-Sync 310 Hz (with 300 Hz → 10 Hz alpha beat: relaxed awareness)', freq: 310, tolerance: 1.5 },
    ],
  },
  {
    category: 'High / near-ultrasonic',
    items: [
      { name: 'Mosquito tone (17.4 kHz)', freq: 17400, tolerance: 60 },
      { name: 'Ultrasonic beacon (18.5 kHz)', freq: 18500, tolerance: 100 },
      { name: 'Ultrasonic beacon (19.5 kHz)', freq: 19500, tolerance: 100 },
    ],
  },
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export { NOTE_NAMES };

export function noteToFreq(note, octave) {
  const midi = (octave + 1) * 12 + NOTE_NAMES.indexOf(note);
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function freqToNote(freq) {
  if (!(freq > 0)) return null;
  const midi = 12 * Math.log2(freq / 440) + 69;
  const rounded = Math.round(midi);
  const cents = Math.round((midi - rounded) * 100);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12] + (Math.floor(rounded / 12) - 1);
  return { name, cents };
}

// Brainwave bands for binaural beats, with the uses and the Monroe Institute
// Focus levels commonly associated with them.
export const BEAT_BANDS = [
  { max: 4, name: 'Delta', use: 'deep, dreamless sleep (Monroe\'s sleep programmes)' },
  { max: 8, name: 'Theta', use: 'deep meditation, drowsy "hypnagogic" state (commonly linked to Focus 10: mind awake, body asleep)' },
  { max: 13, name: 'Alpha', use: 'relaxed awareness, calm focus (commonly linked to Focus 12: expanded awareness)' },
  { max: 30, name: 'Beta', use: 'alert, active concentration' },
  { max: 45, name: 'Gamma', use: 'high-level focus and information processing' },
];

export function beatBand(hz) {
  return BEAT_BANDS.find((b) => hz < b.max) || null;
}
