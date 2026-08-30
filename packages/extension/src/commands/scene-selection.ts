/** SDK-free helpers for resolving opaque scene references in the current song snapshot. */

import { badInput, staleReference, type SceneInfo } from '@othmanadi/loophole-core';

/** Bind a modal's numeric dropdown choice to its original opaque scene reference. */
export function sceneReferenceForIndex(
  scenes: readonly Pick<SceneInfo, 'id'>[],
  sceneIndex: number,
): SceneInfo['id'] {
  if (!Number.isSafeInteger(sceneIndex) || sceneIndex < 0) {
    throw badInput(
      'The selected scene index is invalid. Reopen the Session-to-Song dialog and retry.',
    );
  }
  const scene = scenes[sceneIndex];
  if (scene === undefined) {
    throw badInput(
      'The selected scene was not present when the dialog opened. Reopen the dialog and retry.',
    );
  }
  return scene.id;
}

/** Resolve an opaque scene reference against the current bridge enumeration. */
export function sceneIndexForReference(
  scenes: readonly Pick<SceneInfo, 'id'>[],
  sceneId: SceneInfo['id'],
): number {
  const index = scenes.findIndex((scene) => scene.id === sceneId);
  if (index < 0) {
    throw staleReference(
      sceneId,
      'The selected scene is no longer present. Re-list scenes and retry.',
    );
  }
  return index;
}
