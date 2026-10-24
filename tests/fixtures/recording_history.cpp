#include "recording_history.hpp"

using namespace opxy;
using namespace opxy::platform;
// Explicit checks also run in optimized and freestanding target builds.
#define CHECK(value) do { if (!(value)) return __LINE__; } while (false)

static RecordingContext context() { return {1, 2, 0, 16 * 480, 0, 0, true}; }

int main() {
    RecordingHistory h;
    RecordedNote notes[RecordingHistory::capacity];
    RecordingContext c = context();
    CHECK(!h.note_on(0, 60, 100));
    h.sync(c, true);
    CHECK(h.note_on(123, 60, 87));
    h.advance(128);
    h.advance(129); // Preserve fractional timing across scheduler calls.
    h.note_off(60);
    h.advance(2560);
    CHECK(h.snapshot(notes, 120) == 1);
    CHECK(notes[0].position == 123 && notes[0].length == 1);
    CHECK(notes[0].pitch == 60 && notes[0].velocity == 87);

    CHECK(h.note_on(-12, 64, 99)); // Stock permits pickup before pattern zero.
    h.advance(240 * 256);
    h.sync(c, false);
    h.advance(0xffffffffu);
    h.note_off(64);
    CHECK(!h.note_on(500, 67, 90));
    CHECK(h.snapshot(notes, 120) == 2 && notes[1].length == 240);
    h.sync(c, false);
    CHECK(h.size() == 2); // Stop/refresh preserves the partial take.
    CHECK(h.snapshot(notes, 1) == 0 && h.size() == 2);
    h.sync(c, true);
    CHECK(h.size() == 0);

    // Every identity or timing change invalidates history, including while stopped.
    for (unsigned field = 0; field < 7; ++field) {
        c = context(); h.sync(c, true); CHECK(h.note_on(0, 60, 100));
        h.sync(c, false);
        switch (field) {
            case 0: ++c.project; break;
            case 1: ++c.pattern; break;
            case 2: ++c.track; break;
            case 3: ++c.length; break;
            case 4: ++c.scale; break;
            case 5: ++c.quantization; break;
            case 6: c.eligible = false; break;
        }
        h.sync(c, false); CHECK(h.size() == 0);
    }

    c = context(); c.length = 480; h.sync(c, true);
    CHECK(h.note_on(400, 60, 90)); h.advance(80 * 256); h.note_off(60);
    CHECK(h.note_on(0, 61, 91)); h.advance(399 * 256); h.note_off(61);
    CHECK(h.snapshot(notes, 120) == 2);
    CHECK(notes[0].position == 400 && notes[1].position == 0);
    h.advance(256); CHECK(h.snapshot(notes, 120) == 2); // One loop is not a hard cutoff.
    h.advance(240 * 256); CHECK(h.snapshot(notes, 120) == 1 && notes[0].pitch == 61);
    h.advance(80 * 256); CHECK(h.size() == 0); // Silence ages notes out.
    CHECK(h.note_on(0, 62, 92)); h.advance(0xffffffffu); CHECK(h.size() == 0);

    // A slightly early onset survives a capture at the following downbeat.
    c = context(); h.sync(c, true);
    CHECK(h.note_on(-12, 65, 97)); h.advance(40 * 256); h.note_off(65);
    h.advance((c.length - 28) * 256); // Age = one loop plus twelve ticks.
    CHECK(h.snapshot(notes, 120) == 1);
    CHECK(notes[0].position == -12 && notes[0].length == 40 && notes[0].velocity == 97);
    h.advance(227 * 256); CHECK(h.size() == 1);
    h.advance(256); CHECK(h.size() == 0); // Tolerance is bounded, even in silence.
    CHECK(h.note_on(0, 65, 97)); h.advance((c.length + 100) * 256);
    CHECK(h.snapshot(notes, 120) == 1 && notes[0].length == c.length);
    h.advance(140 * 256); CHECK(h.size() == 0);

    // A full history retains the most recent bounded set; releases of evicted
    // notes cannot damage later notes. Repeated passes remain bounded.
    c = context(); h.sync(c, true);
    for (unsigned i = 0; i < 10000; ++i) {
        CHECK(h.note_on(i % c.length, i % 128, 100));
        h.advance(256); h.note_off(i % 128);
        CHECK(h.size() <= 120);
    }
    CHECK(h.snapshot(notes, 120) == 120);
    CHECK(notes[0].position == static_cast<i32>(9880 % c.length) &&
          notes[119].position == static_cast<i32>(9999 % c.length));
    CHECK(notes[0].length == 1 && notes[119].length == 1);

    h.clear();
    for (unsigned i = 0; i < 20; ++i) CHECK(h.note_on(0, 40 + i, 80));
    CHECK(!h.note_on(0, 90, 80));
    h.advance(256);
    h.note_off(40); CHECK(h.note_on(1, 90, 80));
    CHECK(h.note_on(2, 41, 90)); // Retrigger frees the previous hold.
    h.advance(256);
    CHECK(h.snapshot(notes, 120) == 22);
    CHECK(notes[1].length == 1 && notes[21].length == 1);
    CHECK(!h.note_on(3, 90, 0)); // MIDI velocity-zero is a release.
    CHECK(h.note_on(3, 91, 80));
    CHECK(!h.note_on(0, 128, 90) && !h.note_on(0, 60, 128));

    const unsigned invalid_lengths[] = {0u, 1u << 23, 0xffffffffu};
    for (unsigned length : invalid_lengths) {
        c.length = length; h.sync(c, true);
        CHECK(h.size() == 0 && !h.note_on(0, 60, 90));
    }
    c = context(); c.track = 8; h.sync(c, true); CHECK(!h.note_on(0, 60, 90));
    c = context(); h.sync(c, true); CHECK(h.note_on(0, 60, 90));
    CHECK(h.snapshot(nullptr, 120) == 0 && h.size() == 1);
    h.clear(); CHECK(h.size() == 0);
    CHECK(h.note_on(0, 60, 90)); // Consume does not pretend transport stopped.
    return 0;
}
