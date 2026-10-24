#pragma once
#include <opxy/types.hpp>

namespace opxy { namespace platform {

// Internal recording state, independent of firmware addresses and input routing.
// The adapter supplies stock recording positions and stock-scaled tick deltas.
// No quantization or conversion from wall-clock time belongs in this buffer.
struct RecordedNote {
    i32 position;
    u32 length;
    u8 pitch, velocity;
};

struct RecordingContext {
    u32 project, pattern, track, length, scale, quantization;
    bool eligible;

    bool operator==(const RecordingContext& other) const {
        return project == other.project && pattern == other.pattern &&
            track == other.track && length == other.length &&
            scale == other.scale && quantization == other.quantization &&
            eligible == other.eligible;
    }
};

class RecordingHistory {
public:
    // Stock's ordinary note container and active recording list limits.
    static const u32 capacity = 120;
    static const u32 held_capacity = 20;

    RecordingHistory() : context_{}, count_(0), held_(0), span_(0), playing_(false) {}

    // length is in stock pattern ticks, not bars or elapsed milliseconds.
    // Stop freezes the partial pass; a subsequent start begins a new take.
    void sync(const RecordingContext& context, bool playing) {
        const bool valid = context.eligible && context.track < 8 &&
            context.length > 0 && context.length < (1u << 23);
        const bool running = valid && playing;
        if (!(context == context_) || (running && !playing_)) clear();
        if (!valid) clear();
        if (!running && playing_) {
            for (u32 i = 0; i < count_; ++i) entries_[i].held = false;
            held_ = 0;
        }
        context_ = context;
        span_ = valid ? context.length << 8 : 0;
        playing_ = running;
    }

    // Same Q8-scaled delta that stock accumulates for held recorded notes.
    // Age advances during silence as well: the window is musical time, not a
    // fixed number of recently received notes. Saturating comparisons avoid
    // overflow even after an arbitrarily long session or a large clock jump.
    void advance(u32 delta) {
        if (!playing_ || !delta) return;
        u32 kept = 0;
        for (u32 i = 0; i < count_; ++i) {
            Entry entry = entries_[i];
            if (delta >= span_ - entry.age) {
                if (entry.held) --held_;
                continue;
            }
            entry.age += delta;
            if (entry.held) {
                entry.duration += delta;
                entry.note.length = entry.duration >> 8;
            }
            entries_[kept++] = entry;
        }
        count_ = kept;
    }

    // Receives normalized live input only. The platform must exclude playback,
    // step entry and generated notes. A repeated key ends its previous hold.
    bool note_on(i32 position, u32 pitch, u32 velocity) {
        if (!playing_ || pitch > 127 || velocity > 127) return false;
        note_off(pitch);
        if (!velocity || held_ == held_capacity) return false;
        if (count_ == capacity) {
            if (entries_[0].held) --held_;
            for (u32 i = 1; i < count_; ++i) entries_[i - 1] = entries_[i];
            --count_;
        }
        Entry& entry = entries_[count_++];
        entry.note = {position, 0, static_cast<u8>(pitch), static_cast<u8>(velocity)};
        entry.age = entry.duration = 0;
        entry.held = true;
        ++held_;
        return true;
    }

    void note_off(u32 pitch) {
        if (!playing_) return;
        for (u32 i = 0; i < count_; ++i) {
            Entry& entry = entries_[i];
            if (entry.held && entry.note.pitch == pitch) {
                entry.held = false;
                --held_;
            }
        }
    }

    u32 size() const { return count_; }

    // Keep input order for stock's collision/capacity policy, even when a
    // loop wrap makes recorded positions descend. A snapshot never consumes
    // history. The caller clears it only after a successful pattern commit.
    u32 snapshot(RecordedNote* notes, u32 available) const {
        if (!notes || available < count_) return 0;
        for (u32 i = 0; i < count_; ++i) notes[i] = entries_[i].note;
        return count_;
    }

    void clear() { count_ = held_ = 0; }

private:
    struct Entry {
        RecordedNote note;
        u32 age, duration;
        bool held;
    };
    RecordingContext context_;
    Entry entries_[capacity];
    u32 count_, held_, span_;
    bool playing_;
};

}}
