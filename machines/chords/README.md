# Chords note player

Hold chord types and extensions on one octave of the keyboard and play roots
on the rest; every root sounds the held chord. It plays whichever instrument
the track uses, live or from the sequencer.

| Keys | Role |
| --- | --- |
| Below C4, and from C5 up | Chord roots |
| C4 D4 E4 F4 G4 A4 B4 | Chord types: dim, aug, min, maj, sus (sus4), dom (dominant 7) and half (half-diminished 7). The last one pressed wins |
| C♯4 D♯4 F♯4 G♯4 A♯4 | Extensions 6, m7, M7, 9 and 11 (+9, +10, +11, +14 and +17 semitones). They stack |

With no chord type held, a root plays alone. Extensions only apply with a
chord type. Combinations build richer chords: maj + m7 is a dominant 7th,
dim + 6 a diminished 7th, min + m7 + 9 a minor 9th, dom + 9 + 11 an 11th.
A tone that two keys add sounds once, so a chord holds at most eight tones.
Modifier keys are ordinary notes, so sequencer steps on that octave change the
chord during playback.

| Encoder | Control | Range |
| --- | --- | --- |
| 1 | Strum | 64 steps: the delay between chord tones, in player steps |
| 2 | Direction | Up, down, alternating each chord, or a random first tone |
| 3 | Voicing | -6..+6 inversion steps: each step up moves the lowest note an octave up, each step down the highest an octave down |
| 4 | Spread | Off or on: every second note rises an octave |

This version uses the stock Maestro page, so the screen shows Maestro's
captions above these encoders. Defaults are Strum 0, Direction up, Voicing 0
and Spread off.

The chord engine is [`player.cpp`](player.cpp); [`tests/chords.cpp`](tests/chords.cpp)
holds its musical vectors.
