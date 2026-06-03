# Recipe: build arrangement

Sketch a song structure from a Session full of loops: survey what is there, plan a section order, and optionally stage the sections as MIDI clips in Session view.

This recipe calls bridge MCP tools only. It does not import bridge code or touch Live directly.

## What the bridge can and cannot do here

The bridge has no Arrangement-write tool. `live_create_midi_clip` targets Session clip slots, not the Arrangement timeline, and there is no tool that places clips on the Arrangement. So this recipe does two honest things: it plans the arrangement, and it can stage sections in Session view. It does not write the Arrangement timeline.

For the real Session-to-Arrangement build (recreating clips on the Arrangement at the right bars, named, colored, with cue points, in one undo), use the **Session-to-Song** extension (a `.ablx` from the Loophole Kit). That runs inside Live with SDK access this skill does not have. This recipe is the lightweight planner around it.

## Inputs

- A target structure, e.g. "Intro 8, Verse 16, Chorus 16, Bridge 8, Outro 8".
- Optional: which existing Session clips map to which section.

## Tool sequence (plan, read-only)

1. `live_get_song_overview`. Read tempo, the track list, and the scene count.
2. For the key tracks, `live_list_clips` with `{ trackId }` to see which Session clips exist and their ids.
3. Propose a section order, referencing clips by id, and describe how each section lays out in bars. Present this to the user. Mutate nothing yet.

## Optional: stage sections in Session view (mutating)

If the user wants the sections staged as empty clips to fill (in Session view, not the Arrangement):

4. `live_list_clips` to find empty session slots (`kind: "empty"`, with `slotId`).
5. For each section, `live_create_midi_clip` with `{ slotId, lengthBeats }` (bars times beats per bar; assume 4/4 unless a scene signature is read).
6. Optionally `live_set_notes` to fill a created clip, and `live_set_track_props` to name the track.

## Undo

Counts per tool call, not per recipe. The plan path (steps 1 to 3) writes nothing, so there is nothing to undo. In the optional staging path, each `live_create_midi_clip`, each `live_set_notes`, and each `live_set_track_props` is its own undo step. Staging five sections is at least five undo steps, more if you fill or rename. This recipe does not revert in a single undo. The single-undo Arrangement build is what the Session-to-Song extension provides.

## Notes and limits

- No Arrangement timeline write in this skill. Session view staging plus the planner only. Point the user at the Session-to-Song extension for the Arrangement build.
- `live_create_midi_clip` on an occupied slot returns `SDK_REJECTED`; pick an empty slot.
- The plan path is fully read-only, so the user can approve the structure before anything is created.
