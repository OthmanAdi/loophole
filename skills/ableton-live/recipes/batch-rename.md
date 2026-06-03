# Recipe: batch rename tracks

Rename several tracks consistently from a rule: add a prefix, apply a naming scheme, or clean up placeholder names. Reads the current names, computes each new name, then applies them one track at a time.

This recipe calls bridge MCP tools only. It does not import bridge code or touch Live directly.

## Inputs

- `pattern`, the renaming rule, e.g. "prefix every drum track with DRUM\_", or "Title Case every track name", or "rename Audio 1..4 to Kick, Snare, Hat, Perc".
- Optional: a subset filter, if only some tracks should change.

## Tool sequence

1. `live_get_song_overview` to read every track's current name and id in one call. For a subset, `live_find_track` with `{ query }` resolves a name or substring to matching track ids.
2. Compute each new name from the rule (no tool call). Build the old to new mapping. Skip tracks whose name would not change.
3. For each track that changes, `live_set_track_props` with `{ trackId, props: { name: "<new name>" } }`. One call per track.

If the change is large, print the old to new mapping and confirm with the user before step 3.

## Undo

One undo step per track. Renaming three tracks is three `live_set_track_props` calls, so three undo steps, one per track. This recipe is not a single undo. If the user wants to revert all of them, they undo once per renamed track.

## Notes and limits

- `live_set_track_props` sets name, mute, solo, and arm. This recipe uses `name` only, but you can batch other props in the same call (still one undo per call).
- A stale `trackId` (the track was deleted or its index shifted) returns `STALE_REFERENCE`; re-run `live_get_song_overview` for fresh ids.
- For content-aware MIDI clip naming, Ableton's own RNMR does that better. This recipe renames tracks, not clip contents.
- `live_get_song_overview` and `live_find_track` are read-only, so you can preview the full mapping before any write.
