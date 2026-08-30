# Recipe: chord from prompt

Turn a text request ("warm Fm7 to Bbm7 loop", "four-bar I-V-vi-IV in the Set's key") into MIDI chords written to a clip, staying in the key already set in Live. Reads the Set's scale and tempo, builds the voicings in the model, then writes them.

This recipe calls bridge MCP tools only. It does not import bridge code or touch Live directly.

## Inputs

- A chord request in words: the progression, the feel, the length in bars.
- Either an existing MIDI `clipId` to write into, or a target session slot to create one in.

## Tool sequence

1. `live_get_song_overview`. Read `scale` (root note, scale name, intervals), `tempo`, and the track list. Use the scale so the chords stay in the key the user already set; do not guess a key.
2. If you need a clip:
   - `live_list_clips` with the current returned `{ trackId }` to find an empty Session slot and receive its opaque `slotId`.
   - `live_create_midi_clip` with `{ slotId, lengthBeats }` (bars times beats per bar; assume 4/4 unless a scene signature is read). It returns the new `clipId`.
3. Build the chord notes in the model (no tool call): pick chord roots from the progression, voice each chord as note pitches within the Set's scale intervals, set each note's `startTime` and `duration` from the bar positions, and choose velocities. Keep pitches in 0 to 127.
4. `live_set_notes` with `{ clipId, notes }`, the full chord array.

## Undo

Counts per tool call, not per recipe:

- Writing into an existing clip performs one mutation.
- Creating a clip and then filling it performs two mutations: `live_create_midi_clip`, then `live_set_notes`. The SDK must return the clip before notes can be assigned, so the combined operation is not atomic.

State the mutation count before writing and ask the user to confirm the resulting Live undo entries.

## Notes and limits

- The chord voicing logic lives in the model, not in a tool. The tools read the scale and write the notes; you decide the voicings.
- `live_create_midi_clip` targets session clip slots, not the Arrangement timeline. If the slot is occupied it returns `SDK_REJECTED`; pick an empty slot from `live_list_clips`.
- Stay within the Set's scale intervals from `live_get_song_overview` to keep chords in key. If no scale is set, ask the user for a key rather than guessing.
- MIDI only. No automation or CC in this beta.
