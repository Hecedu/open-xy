#include <opxy/player.hpp>

// Chord player. Keys below the split play chord roots; the
// octave from the split up holds chord modifiers, which never sound:
//   white C D E F G A B  chord type  dim aug min maj sus dom half
//   black C# D# F# G# A#  extension  6 m7 M7 9 11
// A root plays the most recently held chord type with every held extension,
// or itself alone when no type is held. Keys above that octave are roots too.
namespace chords {
using opxy::u8;
using opxy::u32;
using opxy::i32;
using opxy::player::Controls;
using opxy::player::Plan;

const u32 kSplit = 60;  // C4: the first modifier key
enum Type : u8 { kNone, kDim, kAug, kMin, kMaj, kSus, kDom, kHalf, kTypes };
const u32 kExtensionCount = 5;

struct State {
    u8 held;        // bit per chord type
    u8 last;        // most recently pressed held type
    u8 extensions;  // bit per extension
    u8 descending;  // alternate direction: the next chord's order
    u32 seed;     // random direction
};

namespace {
// Semitones above the root. Dominant and half-diminished are seventh chords;
// the others are triads. Extensions: 6, m7, M7, 9 and 11.
const u8 kChordTones[kTypes] = {0, 3, 3, 3, 3, 3, 4, 4};
const u8 kChords[kTypes][4] = {{0}, {0, 3, 6}, {0, 4, 8}, {0, 3, 7}, {0, 4, 7}, {0, 5, 7}, {0, 4, 7, 10}, {0, 3, 6, 10}};
const u8 kExtensions[kExtensionCount] = {9, 10, 11, 14, 17};
const i32 kVoicingSteps = 6;  // the voicing encoder spans -6..+6 inversion steps

// Pitch class of a modifier key -> chord type (1..7) or extension (kTypes + 0..4).
const u8 kModifier[12] = {kDim, kTypes, kAug, kTypes + 1, kMin, kMaj, kTypes + 2, kSus, kTypes + 3, kDom, kTypes + 4, kHalf};

int modifier(u32 note) {
    return note >= kSplit && note < kSplit + 12 ? kModifier[note - kSplit] : -1;
}

u32 steps(i32 value, u32 count) {  // Q31 0..1 -> 0..count-1, count <= 65536
    const u32 v = value < 0 ? 0u : static_cast<u32>(value) >> 16;
    const u32 step = (v * count) >> 15;
    return step < count ? step : count - 1;
}

void add(i32* notes, u32& count, i32 pitch) {
    for (u32 i = 0; i < count; ++i)
        if (notes[i] == pitch) return;
    if (count < opxy::player::max_tones) notes[count++] = pitch;
}

void sort(i32* notes, u32 count) {
    for (u32 i = 1; i < count; ++i)
        for (u32 j = i; j > 0 && notes[j - 1] > notes[j]; --j) {
            const i32 t = notes[j];
            notes[j] = notes[j - 1];
            notes[j - 1] = t;
        }
}

// Voicing: each step up moves the lowest note an octave up, each step down
// the highest note an octave down.
void voice(i32* notes, u32 count, i32 voicing) {
    for (; voicing > 0; --voicing) { notes[0] += 12; sort(notes, count); }
    for (; voicing < 0; ++voicing) { notes[count - 1] -= 12; sort(notes, count); }
}
}

bool release(State& state, u32 note) {
    const int m = modifier(note);
    if (m < 0) return false;
    if (m >= kDim && m < kTypes) {
        state.held &= static_cast<u8>(~(1u << m));
        if (state.last == m) {
            state.last = kNone;
            for (u8 t = kDim; t < kTypes; ++t)
                if (state.held & (1u << t)) state.last = t;
        }
    } else {
        state.extensions &= static_cast<u8>(~(1u << (m - kTypes)));
    }
    return true;
}

bool press(State& state, const Controls& controls, u32 note, u32 velocity, Plan& plan) {
    plan.count = 0;
    const int m = modifier(note);
    if (m >= kDim && m < kTypes) {
        state.held |= static_cast<u8>(1u << m);
        state.last = static_cast<u8>(m);
        return true;
    }
    if (m >= kTypes) {
        state.extensions |= static_cast<u8>(1u << (m - kTypes));
        return true;
    }

    i32 notes[opxy::player::max_tones];
    u32 count = 0;
    if (state.last == kNone) {
        notes[count++] = static_cast<i32>(note);
    } else {
        for (u32 i = 0; i < kChordTones[state.last]; ++i) notes[count++] = static_cast<i32>(note + kChords[state.last][i]);
        // Seventh chords hold at most 4 + 4 distinct tones: their m7 is already present.
        for (u32 i = 0; i < kExtensionCount; ++i)
            if (state.extensions & (1u << i)) add(notes, count, static_cast<i32>(note + kExtensions[i]));
    }
    sort(notes, count);
    voice(notes, count, static_cast<i32>(steps(controls.value[2], 2 * kVoicingSteps + 1)) - kVoicingSteps);
    // Spread opens the voicing: every second note rises an octave.
    if (steps(controls.value[3], 2)) {
        for (u32 i = 1; i < count; i += 2) notes[i] += 12;
        sort(notes, count);
    }

    // Direction: up, down, alternating per chord, or a random rotation.
    const u32 direction = steps(controls.value[1], 4);
    bool down = direction == 1;
    if (direction == 2) {
        down = state.descending != 0;
        state.descending = !state.descending;
    }
    u32 rotate = 0;
    if (direction == 3) {
        state.seed = state.seed * 1664525u + 1013904223u;
        rotate = (state.seed >> 16) % count;
    }
    const u32 strum = steps(controls.value[0], 64);
    for (u32 i = 0; i < count; ++i) {
        const u32 k = (i + rotate) % count;
        const i32 pitch = notes[down ? count - 1 - k : k];
        if (pitch < 0 || pitch > 127) continue;
        opxy::player::Tone& tone = plan.tones[plan.count];
        tone.pitch = static_cast<u8>(pitch);
        tone.velocity = static_cast<u8>(velocity);
        tone.delay = static_cast<opxy::u16>(plan.count * strum);
        ++plan.count;
    }
    return true;
}
}
