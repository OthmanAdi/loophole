# Recipe: build arrangement

Sketch a song structure from a Session full of loops: survey what is there, plan a section order, and optionally stage the sections as MIDI clips in Session view.

This recipe calls bridge MCP tools only. It does not import bridge code or touch Live directly.

## What the bridge can and cannot do here

The bridge has no Arrangement-write tool. `live_create_midi_clip` targets Session clip slots, not the Arrangement timeline, and there is no tool that places clips on the Arrangement. So this recipe does two honest things: it plans the arrangement, and it can stage sections in Session view. It does not write the Arrangement timeline.

For a real Session-to-Arrangement build, use the **Session-to-Song** extension from the locally packaged `.ablx`. It preflights, then runs ordered clear, create, and populate phases. The receipt reports physical clip and cue counts plus 0 intended undo entries for a no-op, 2 for cue-only, or 3 when it clears, creates, and populates.

## Inputs

- A target structure, e.g. "Intro 8, Verse 16, Chorus 16, Bridge 8, Outro 8".
- Optional: which existing Session clips map to which section.

## Tool sequence (plan, read-only)

1. `live_get_song_overview`. Read tempo, the track list, and the scene count.
2. For the key tracks, `live_list_clips` with the current returned `{ trackId }` to see which Session clips exist and receive current opaque references.
3. Propose a section order, referring to clips by name and their returned opaque references. Present this to the user. Mutate nothing yet.

## Optional: stage sections in Session view (mutating)

If the user wants the sections staged as empty clips to fill (in Session view, not the Arrangement):

4. `live_list_clips` to find empty session slots (`kind: "empty"`, with `slotId`).
5. For each section, `live_create_midi_clip` with `{ slotId, lengthBeats }` (bars times beats per bar; assume 4/4 unless a scene signature is read).
6. Optionally `live_set_notes` to fill a created clip, and `live_set_track_props` to name the track.

## Undo

The plan path writes nothing. In the optional staging path, each `live_create_midi_clip`, `live_set_notes`, and `live_set_track_props` call is a separate mutation. State that count before writing and do not call the recipe atomic. The Session-to-Song extension uses ordered clear, create, and populate phases, not one transaction. A partial error's `undoStepsToRestore` is the exact recovery count.

## Notes and limits

- No Arrangement timeline write in this skill. Session view staging plus the planner only. Point the user at the Session-to-Song extension for the Arrangement build.
- `live_create_midi_clip` on an occupied slot returns `SDK_REJECTED`; pick an empty slot.
- The plan path is fully read-only, so the user can approve the structure before anything is created.
