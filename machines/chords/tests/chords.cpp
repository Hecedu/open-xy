// Musical vectors for the Chords player, compiled for the host by tests/test_players.py.
#include "../player.cpp"
#include <cstdio>
#include <initializer_list>

namespace {
int failures = 0;
const opxy::i32 kCentre = 0x40000000, kTop = 0x7fffffff;
// The modifier octave from C4.
enum Key : unsigned { kDimKey = 60, k6 = 61, kAugKey = 62, kM7minor = 63, kMinKey = 64, kMajKey = 65,
                      kM7major = 66, kSusKey = 67, k9 = 68, kDomKey = 69, k11 = 70, kHalfKey = 71 };

opxy::i32 step(unsigned index, unsigned count) {  // the centre of an encoder step
    return static_cast<opxy::i32>((2ull * index + 1) * 0x40000000ull / count);
}

void expect(const char* what, const opxy::player::Plan& plan, const int* pitches, const int* delays, unsigned count) {
    bool ok = plan.count == count;
    for (unsigned i = 0; ok && i < count; ++i)
        ok = plan.tones[i].pitch == pitches[i] && plan.tones[i].delay == delays[i] && plan.tones[i].velocity == 90;
    if (!ok) {
        ++failures;
        std::printf("FAIL %s:", what);
        for (unsigned i = 0; i < plan.count; ++i) std::printf(" %d@%d", plan.tones[i].pitch, plan.tones[i].delay);
        std::printf("\n");
    }
}

void check(const char* what, bool ok) {
    if (!ok) { ++failures; std::printf("FAIL %s\n", what); }
}
}

int main() {
    chords::State state = {};
    opxy::player::Controls controls = {{0, 0, kCentre, 0}};
    opxy::player::Plan plan;
    const int none[8] = {0, 0, 0, 0, 0, 0, 0, 0};
    auto hold = [&](unsigned key) { chords::press(state, controls, key, 90, plan); };
    auto play = [&](unsigned root) { chords::press(state, controls, root, 90, plan); };

    check("plain root taken", chords::press(state, controls, 48, 90, plan));
    { const int p[] = {48}; expect("no chord type plays the root", plan, p, none, 1); }
    check("plain root release goes to stock", !chords::release(state, 48));

    for (unsigned key = 60; key < 72; ++key)
        check("every modifier key is taken silently", chords::press(state, controls, key, 90, plan) && plan.count == 0);
    for (unsigned key = 60; key < 72; ++key) check("every modifier release is taken", chords::release(state, key));

    struct { unsigned type; int tones[4]; unsigned count; const char* name; } types[] = {
        {kDimKey, {48, 51, 54}, 3, "C dim"},    {kAugKey, {48, 52, 56}, 3, "C aug"},
        {kMinKey, {48, 51, 55}, 3, "C minor"},  {kMajKey, {48, 52, 55}, 3, "C major"},
        {kSusKey, {48, 53, 55}, 3, "C sus4"},   {kDomKey, {48, 52, 55, 58}, 4, "C7"},
        {kHalfKey, {48, 51, 54, 58}, 4, "Cm7b5"},
    };
    for (auto& t : types) {
        hold(t.type); play(48);
        expect(t.name, plan, t.tones, none, t.count);
        chords::release(state, t.type);
    }

    hold(kMajKey); hold(kM7minor); play(48);
    { const int p[] = {48, 52, 55, 58}; expect("major + m7 = dominant 7", plan, p, none, 4); }
    hold(kMinKey); play(57);  // the most recent type wins
    { const int p[] = {57, 60, 64, 67}; expect("Am7", plan, p, none, 4); }
    chords::release(state, kMinKey); play(57);
    { const int p[] = {57, 61, 64, 67}; expect("A7 after min released", plan, p, none, 4); }
    hold(k9); play(48);
    { const int p[] = {48, 52, 55, 58, 62}; expect("C9", plan, p, none, 5); }
    hold(k11); play(48);
    { const int p[] = {48, 52, 55, 58, 62, 65}; expect("C11", plan, p, none, 6); }
    chords::release(state, kM7minor); chords::release(state, k9); chords::release(state, k11); chords::release(state, kMajKey);

    hold(kDomKey); hold(kM7minor); play(48);
    { const int p[] = {48, 52, 55, 58}; expect("dom + m7 keeps one seventh", plan, p, none, 4); }
    hold(k6); hold(kM7major); hold(k9); hold(k11); play(48);
    { const int p[] = {48, 52, 55, 57, 58, 59, 62, 65}; expect("dom with every extension fits eight tones", plan, p, none, 8); }
    for (unsigned key : {kDomKey, kM7minor, k6, kM7major, k9, k11}) chords::release(state, key);
    hold(kDimKey); hold(k6); play(48);
    { const int p[] = {48, 51, 54, 57}; expect("dim + 6 = diminished 7", plan, p, none, 4); }
    chords::release(state, k6); chords::release(state, kDimKey);
    hold(kSusKey);
    play(72);
    { const int p[] = {72, 77, 79}; expect("keys above the modifier octave are roots", plan, p, none, 3); }

    controls.value[0] = step(4, 64);
    play(48);
    { const int p[] = {48, 53, 55}, d[] = {0, 4, 8}; expect("strum 4", plan, p, d, 3); }
    controls.value[1] = step(1, 4);
    play(48);
    { const int p[] = {55, 53, 48}, d[] = {0, 4, 8}; expect("strum down", plan, p, d, 3); }
    controls.value[1] = step(2, 4);
    play(48);
    { const int p[] = {48, 53, 55}, d[] = {0, 4, 8}; expect("alternate starts up", plan, p, d, 3); }
    play(48);
    { const int p[] = {55, 53, 48}, d[] = {0, 4, 8}; expect("alternate then down", plan, p, d, 3); }
    controls.value[0] = 0; controls.value[1] = 0;

    controls.value[2] = kTop;
    play(48);
    { const int p[] = {72, 77, 79}; expect("voicing +6 on a triad", plan, p, none, 3); }
    controls.value[2] = 0;
    play(48);
    { const int p[] = {24, 29, 31}; expect("voicing -6 on a triad", plan, p, none, 3); }
    controls.value[2] = kCentre;
    controls.value[3] = kTop;
    chords::release(state, kSusKey);
    hold(kDomKey); play(48);
    { const int p[] = {48, 55, 64, 70}; expect("spread C7", plan, p, none, 4); }
    controls.value[3] = 0;

    controls.value[2] = kTop;
    play(120);
    check("tones above 127 are dropped", plan.count < 4);
    for (unsigned i = 0; i < plan.count; ++i) check("pitches stay in range", plan.tones[i].pitch <= 127);

    if (failures) std::printf("%d failures\n", failures);
    return failures ? 1 : 0;
}
