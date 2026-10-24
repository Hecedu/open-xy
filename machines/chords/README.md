# Chords note player

An Orchid-style chord player. Hold chord types and extensions on the upper
octave of the keyboard and play roots below; every root sounds the held chord.
It plays whichever instrument the track uses, live or from the sequencer.

| Keys | Role |
| --- | --- |
| Below C4, and from C5 up | Chord roots |
| C4, D4, E4, F4 | Chord types Dim, Min, Maj and Sus (sus4); the last one pressed wins |
| C♯4, D♯4, F♯4, G♯4 | Extensions 6, m7, M7 and 9 (+9, +10, +11 and +14 semitones); they stack |
| G4, G♯4… B4 others | Silent |

With no chord type held, a root plays alone. Extensions only apply with a
chord type, as on Orchid. Modifier keys are ordinary notes, so sequencer steps
on that octave change the chord during playback.

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
holds its musical vectors. Telepathic Instruments' Orchid inspired the key
layout and voicing behaviour; this is an independent implementation, not
affiliated with them.
