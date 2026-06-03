# Recipe: humanize MIDI

Take a stiff, quantized MIDI clip and nudge it so it feels played: small shifts to note timing, with optional velocity and probability variation. Reads the notes, transforms them in the model, writes the whole array back.

This recipe calls bridge MCP tools only. It does not import bridge code or touch Live directly.

## Inputs

- `clipId`, the clip to humanize, e.g. `track:2/clipslot:4/clip`. Get it from `live_list_clips` if you only have a track.
- `amount`, how far to nudge timing, in beats, e.g. `0.02` (subtle) to `0.08` (loose). Stay well under one grid cell so the feel stays musical.
- Optional: vary velocity by a few units, and set `probability` slightly below 1 on some notes for a living pattern.

## Tool sequence

1. `live_get_notes` with `{ clipId }`. Read the current notes (each has `pitch`, `startTime`, `duration`, and optional `velocity`, `probability`).
2. Transform the array in the model (no tool call): for each note, shift `startTime` by a small random amount within plus or minus `amount` beats, clamped so it never goes below 0. Optionally vary `velocity` within 1 to 127, and set `probability` a little below 1 on some notes. Keep the note count and pitches unchanged; move timing, velocity, and probability only.
3. `live_set_notes` with `{ clipId, notes }`, passing the full transformed array. This replaces every note in the clip.

## Undo

One undo step. `live_set_notes` is a single bridge mutation, so one Ctrl/Cmd-Z reverts the whole humanize.

## Notes and limits

- MIDI clips only. `live_set_notes` on an audio clip returns a `WRONG_TYPE` error; pick a MIDI clip id from `live_list_clips`.
- The result is random within the bounds you set: run it twice and you get two different feels, which is the point.
- Timing, velocity, duration, and probability are the only fields in play. No automation, MIDI CC, or audio in this beta.
- The bridge clamps pitch and velocity to 0 to 127 on write, so an out-of-range value is rejected the way Live would reject it.
- Read-only first: `live_get_notes` changes nothing, so you can inspect the clip before deciding whether to write.
