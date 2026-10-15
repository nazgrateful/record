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
      { name: '432 Hz tuning', freq: 432, tolerance: 2 },
      { name: '528 Hz "solfeggio"', freq: 528, tolerance: 3 },
      { name: 'Low E string (E2)', freq: 82.41, tolerance: 2 },
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
