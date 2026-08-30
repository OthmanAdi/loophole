import { describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => {
  class DataModelObject {
    constructor(id) {
      this.handle = { id };
    }
  }
  class ClipSlot extends DataModelObject {
    clip = null;
  }
  class MidiClip extends DataModelObject {}
  class MidiTrack extends DataModelObject {}
  class AudioTrack extends DataModelObject {}
  return {
    DataModelObject,
    ClipSlot,
    MidiClip,
    MidiTrack,
    AudioTrack,
    GridQuantization: {},
  };
});

vi.mock('@ableton-extensions/sdk', () => sdk);

import { ReferenceService } from './reference-service.js';
import { Resolver } from './resolver.js';
import { AbletonLiveBridge } from './live-bridge.ableton.js';
import {
  audioTrackSelectionToTargets,
  clipIdFromHandle,
  midiClipIdsFromSlotSelection,
  trackIdFromHandle,
} from './selection.js';

function object(id) {
  return new sdk.DataModelObject(id);
}

function track(id) {
  return {
    ...object(id),
    clipSlots: [],
    arrangementClips: [],
    devices: [],
    mixer: { volume: object(id + 10_000n) },
  };
}

function context(tracks, selected) {
  return {
    application: { song: { tracks, scenes: [], cuePoints: [] } },
    getObjectFromHandle: () => selected,
  };
}

function trackWithMixer(id) {
  const candidate = new sdk.MidiTrack(id);
  candidate.clipSlots = [];
  candidate.arrangementClips = [];
  candidate.devices = [];
  candidate.mixer = {
    volume: { ...object(id + 10_000n), getValue: async () => 0 },
    panning: { ...object(id + 20_000n), getValue: async () => 0 },
    sends: [],
  };
  return candidate;
}

describe('identity-based recovery', () => {
  it('keeps the exact same-id object through resolver track, slot, clip, and device recovery', () => {
    const firstTrack = track(1n);
    const secondTrack = track(1n);
    const tracks = [firstTrack, secondTrack];
    const references = new ReferenceService(context(tracks, secondTrack));
    const resolver = new Resolver(context(tracks, secondTrack), references);

    const trackRef = references.issueTrack(secondTrack, 1);
    expect(resolver.resolveTrack(trackRef)).toMatchObject({ track: secondTrack, index: 1 });

    const firstSlot = new sdk.ClipSlot(2n);
    const secondSlot = new sdk.ClipSlot(2n);
    secondTrack.clipSlots.push(firstSlot, secondSlot);
    const slotRef = references.issueClipSlot(secondSlot, 1, 1);
    expect(resolver.resolveSlot(slotRef)).toMatchObject({
      track: secondTrack,
      trackIndex: 1,
      slot: secondSlot,
      slotIndex: 1,
    });

    const firstSessionClip = new sdk.MidiClip(3n);
    const secondSessionClip = new sdk.MidiClip(3n);
    firstSlot.clip = firstSessionClip;
    secondSlot.clip = secondSessionClip;
    const sessionRef = references.issueClip(secondSessionClip, 1, 1);
    expect(resolver.resolveClip(sessionRef)).toMatchObject({
      clip: secondSessionClip,
      location: 'session',
      sceneIndex: 1,
    });

    const firstArrangementClip = new sdk.MidiClip(4n);
    const secondArrangementClip = new sdk.MidiClip(4n);
    secondTrack.arrangementClips.push(firstArrangementClip, secondArrangementClip);
    const arrangementRef = references.issueClip(secondArrangementClip, 1, 1);
    expect(resolver.resolveClip(arrangementRef)).toMatchObject({
      clip: secondArrangementClip,
      location: 'arrangement',
    });

    const firstDevice = { ...object(5n), parameters: [] };
    const secondDevice = { ...object(5n), parameters: [] };
    secondTrack.devices.push(firstDevice, secondDevice);
    const deviceRef = references.issueDevice(secondDevice, 1, 1);
    expect(resolver.resolveDevice(deviceRef)).toMatchObject({
      device: secondDevice,
      trackIndex: 1,
      deviceIndex: 1,
    });
  });

  it('issues selection references for the exact same-id target, never its neighbor', () => {
    const firstTrack = new sdk.AudioTrack(11n);
    const secondTrack = new sdk.AudioTrack(11n);
    for (const candidate of [firstTrack, secondTrack]) {
      candidate.clipSlots = [];
      candidate.arrangementClips = [];
      candidate.devices = [];
      candidate.mixer = { volume: object(101n) };
    }
    const tracks = [firstTrack, secondTrack];
    const selectedContext = context(tracks, secondTrack);
    const references = new ReferenceService(selectedContext);

    const trackRef = trackIdFromHandle(selectedContext, references, secondTrack.handle);
    expect(references.resolveTrack(trackRef)).toBe(secondTrack);

    const firstClip = new sdk.MidiClip(12n);
    const secondClip = new sdk.MidiClip(12n);
    const firstSlot = new sdk.ClipSlot(13n);
    const secondSlot = new sdk.ClipSlot(13n);
    firstSlot.clip = firstClip;
    secondSlot.clip = secondClip;
    secondTrack.clipSlots.push(firstSlot, secondSlot);

    const clipContext = context(tracks, secondClip);
    expect(
      references.resolveClip(clipIdFromHandle(clipContext, references, secondClip.handle)),
    ).toBe(secondClip);

    const slotContext = context(tracks, secondSlot);
    const clipRefs = midiClipIdsFromSlotSelection(slotContext, references, {
      selected_clip_slots: [secondSlot.handle],
    });
    expect(references.resolveClip(clipRefs[0])).toBe(secondClip);

    const audioContext = context(tracks, secondTrack);
    const targets = audioTrackSelectionToTargets(audioContext, references, {
      selected_lanes: [secondTrack.handle],
      time_selection_start: 0,
      time_selection_end: 4,
    });
    expect(references.resolveTrack(targets.trackIds[0])).toBe(secondTrack);
  });

  it('fails creator and cue recovery closed when only a same-id neighbor is listed', async () => {
    const neighborTrack = trackWithMixer(21n);
    const createdTrack = trackWithMixer(21n);
    const neighborCue = { ...object(22n), time: 0, name: '' };
    const createdCue = { ...object(22n), time: 0, name: '' };
    const song = {
      tracks: [neighborTrack],
      scenes: [],
      cuePoints: [neighborCue],
      createMidiTrack: async () => createdTrack,
      createAudioTrack: async () => createdTrack,
      createCuePoint: async () => createdCue,
    };
    const bridgeContext = {
      application: { song },
      withinTransaction: (operation) => operation(),
      resources: { renderPreFxAudio: async () => '' },
    };
    const bridge = new AbletonLiveBridge(bridgeContext, new ReferenceService(bridgeContext));

    await expect(bridge.createTrack('midi')).rejects.toMatchObject({ code: 'SDK_REJECTED' });
    await expect(bridge.createCuePoint(0, 'Cue')).rejects.toMatchObject({ code: 'SDK_REJECTED' });
  });
});
