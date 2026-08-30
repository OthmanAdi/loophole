# Recipe: batch rename tracks

Rename several tracks consistently from a rule: add a prefix, apply a naming scheme, or clean up placeholder names. Reads the current names, computes each new name, then applies them one track at a time.

This recipe calls bridge MCP tools only. It does not import bridge code or touch Live directly.

## Inputs

- `pattern`, the renaming rule, e.g. "prefix every drum track with DRUM\_", or "Title Case every track name", or "rename Audio 1..4 to Kick, Snare, Hat, Perc".
- Optional: a subset filter, if only some tracks should change.

## Tool sequence

1. `live_get_song_overview` to read every track's current name and opaque session reference. For a subset, `live_find_track` resolves a name or substring to current matching references.
2. Compute each new name from the rule (no tool call). Build the old to new mapping. Skip tracks whose name would not change.
3. For each track that changes, `live_set_track_props` with `{ trackId, props: { name: "<new name>" } }`. One call per track.

If the change is large, print the old to new mapping and confirm with the user before step 3.

## Undo

Renaming three tracks is three separate mutations. The bridge is designed to initiate each setter in its own transaction, but the user should confirm the actual undo entries in Live. This recipe is not atomic.

## Notes and limits

- `live_set_track_props` sets name, mute, solo, and arm. This recipe uses `name` only.
- A stale `trackId` returns `STALE_REFERENCE`; re-run `live_get_song_overview` and pass the new opaque reference unchanged.
- For content-aware MIDI clip naming, Ableton's own RNMR does that better. This recipe renames tracks, not clip contents.
- `live_get_song_overview` and `live_find_track` are read-only, so you can preview the full mapping before any write.
