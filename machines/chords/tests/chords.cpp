// Musical vectors for the Chords player, compiled for the host by tests/test_players.py.
#include "../player.cpp"
#include <cstdio>

namespace {
int failures = 0;
const opxy::i32 kCentre = 0x40000000, kTop = 0x7fffffff;

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

    check("plain root taken", chords::press(state, controls, 48, 90, plan));
    { const int p[] = {48}; expect("no chord type plays the root", plan, p, none, 1); }
    check("plain root release goes to stock", !chords::release(state, 48));

    check("modifier taken", chords::press(state, controls, 64, 90, plan) && plan.count == 0);
    chords::press(state, controls, 48, 90, plan);
    { const int p[] = {48, 52, 55}; expect("C major", plan, p, none, 3); }
    chords::press(state, controls, 63, 90, plan);
    chords::press(state, controls, 48, 90, plan);
    { const int p[] = {48, 52, 55, 58}; expect("C7", plan, p, none, 4); }
    chords::press(state, controls, 62, 90, plan);  // Min pressed last wins
    chords::press(state, controls, 57, 90, plan);
    { const int p[] = {57, 60, 64, 67}; expect("Am7", plan, p, none, 4); }
    check("modifier release taken", chords::release(state, 62));
    chords::press(state, controls, 57, 90, plan);
    { const int p[] = {57, 61, 64, 67}; expect("A7 after Min released", plan, p, none, 4); }
    chords::release(state, 63);
    chords::press(state, controls, 66, 90, plan);
    chords::press(state, controls, 68, 90, plan);
    chords::press(state, controls, 48, 90, plan);
    { const int p[] = {48, 52, 55, 59, 62}; expect("Cmaj9", plan, p, none, 5); }
    chords::release(state, 66); chords::release(state, 68); chords::release(state, 64);
    chords::press(state, controls, 60, 90, plan);
    chords::press(state, controls, 61, 90, plan);
    chords::press(state, controls, 48, 90, plan);
    { const int p[] = {48, 51, 54, 57}; expect("Cdim7 from Dim + 6", plan, p, none, 4); }
    chords::release(state, 61); chords::release(state, 60);
    chords::press(state, controls, 65, 90, plan);
    chords::press(state, controls, 48, 90, plan);
    { const int p[] = {48, 53, 55}; expect("Csus4", plan, p, none, 3); }
    check("unused modifier key is silent", chords::press(state, controls, 67, 90, plan) && plan.count == 0);
    chords::press(state, controls, 72, 90, plan);
    { const int p[] = {72, 77, 79}; expect("keys above the modifier octave are roots", plan, p, none, 3); }

    controls.value[0] = step(4, 64);
    chords::press(state, controls, 48, 90, plan);
    { const int p[] = {48, 53, 55}, d[] = {0, 4, 8}; expect("strum 4", plan, p, d, 3); }
    controls.value[1] = step(1, 4);
    chords::press(state, controls, 48, 90, plan);
    { const int p[] = {55, 53, 48}, d[] = {0, 4, 8}; expect("strum down", plan, p, d, 3); }
    controls.value[1] = step(2, 4);
    chords::press(state, controls, 48, 90, plan);
    { const int p[] = {48, 53, 55}, d[] = {0, 4, 8}; expect("alternate starts up", plan, p, d, 3); }
    chords::press(state, controls, 48, 90, plan);
    { const int p[] = {55, 53, 48}, d[] = {0, 4, 8}; expect("alternate then down", plan, p, d, 3); }
    controls.value[0] = 0; controls.value[1] = 0;

    controls.value[2] = kTop;
    chords::press(state, controls, 48, 90, plan);
    { const int p[] = {72, 77, 79}; expect("voicing +6 on a triad", plan, p, none, 3); }
    controls.value[2] = 0;
    chords::press(state, controls, 48, 90, plan);
    { const int p[] = {24, 29, 31}; expect("voicing -6 on a triad", plan, p, none, 3); }
    controls.value[2] = kCentre;
    controls.value[3] = kTop;
    chords::release(state, 65);
    chords::press(state, controls, 64, 90, plan);
    chords::press(state, controls, 63, 90, plan);
    chords::press(state, controls, 48, 90, plan);
    { const int p[] = {48, 55, 64, 70}; expect("spread C7", plan, p, none, 4); }
    controls.value[3] = 0;

    controls.value[2] = kTop;
    chords::press(state, controls, 120, 90, plan);
    check("tones above 127 are dropped", plan.count < 4);
    for (unsigned i = 0; i < plan.count; ++i) check("pitches stay in range", plan.tones[i].pitch <= 127);

    if (failures) std::printf("%d failures\n", failures);
    return failures ? 1 : 0;
}
