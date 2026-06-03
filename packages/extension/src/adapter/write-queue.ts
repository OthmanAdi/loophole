/**
 * A single-lane FIFO that serializes every Live mutation the {@link
 * import("./live-bridge.ableton.js").AbletonLiveBridge} performs.
 *
 * The Extension Host is single-threaded JavaScript, but MCP requests arrive
 * concurrently and each mutation is asynchronous under the hood (the SDK's
 * structural ops resolve a callback into a Promise; see 01_SDK_MAP §0 Rule A). Two
 * writes whose `await`s interleave could corrupt undo grouping or race on the tree
 * structure, so 02_BRIDGE_SPEC §4 mandates one FIFO queue: a write fully completes
 * (its Promise settles) before the next starts. That ordering is what makes "one
 * tool call = one `withinTransaction` = one undo" hold deterministically.
 *
 * This file imports NEITHER the Ableton SDK nor anything from `node:`; it is plain
 * Promise plumbing, so it stays trivially correct and unit-testable. The adapter
 * owns one instance and routes every mutation through {@link WriteQueue.run}; reads
 * bypass the queue entirely (sync getters cannot interleave with themselves, and
 * queueing them would only add latency, per §4).
 */

import { sdkRejected } from '@othmanadi/loophole-core';

/**
 * The default cap on pending (queued but not yet started) tasks. Past this, {@link
 * WriteQueue.run} rejects with a `SDK_REJECTED` "bridge busy" error so a flood of
 * concurrent writes makes the model back off and retry rather than the host
 * ballooning memory (02_BRIDGE_SPEC §4 "Backpressure"). 64 is the value the spec
 * names; it is generous for an interactive MCP session yet bounded.
 */
export const DEFAULT_MAX_PENDING = 64;

/**
 * One serial FIFO for asynchronous mutations. Each {@link WriteQueue.run} call is
 * chained onto the tail of an internal Promise so the next task starts only after
 * the previous one settles, regardless of whether it resolved or rejected (a
 * rejected write must not wedge the lane). The chain itself never rejects; the
 * caller's own returned Promise carries the success or failure of their task.
 */
export class WriteQueue {
  /**
   * The tail of the FIFO: a Promise that settles when the last-enqueued task is
   * done. A new task awaits this, runs, and becomes the new tail. It is kept
   * deliberately untyped at the value level (`Promise<unknown>`) because tasks
   * return heterogeneous results; each caller gets its own typed Promise.
   */
  #tail: Promise<unknown> = Promise.resolve();

  /**
   * Number of tasks enqueued but not yet finished (the live depth of the lane),
   * used to enforce backpressure. Incremented on enqueue, decremented in a
   * `finally` when the task settles.
   */
  #pending = 0;

  readonly #maxPending: number;

  constructor(maxPending: number = DEFAULT_MAX_PENDING) {
    this.#maxPending = maxPending;
  }

  /** The current number of tasks enqueued but not yet settled. */
  get pending(): number {
    return this.#pending;
  }

  /**
   * Enqueue `task` to run after every previously enqueued task has settled, and
   * resolve (or reject) with its result. `task` may be sync or async; either way
   * the queue awaits its settled value before starting the next task.
   *
   * @throws BridgeError `SDK_REJECTED` ("bridge busy") synchronously, before
   *   enqueuing, when the lane already holds {@link DEFAULT_MAX_PENDING} tasks.
   */
  async run<T>(task: () => Promise<T> | T): Promise<T> {
    if (this.#pending >= this.#maxPending) {
      throw sdkRejected(
        `Bridge busy: more than ${String(this.#maxPending)} mutations are queued.`,
        'Wait for in-flight operations to finish, then retry.',
      );
    }
    this.#pending += 1;

    // Chain onto the tail. The `.then` runs `task` only after the prior task
    // settles; we swallow the prior task's outcome here (`catch(() => undefined)`)
    // so one caller's rejection never poisons the next caller's turn — each caller
    // observes its own result through the Promise this method returns.
    const result = this.#tail.then(
      () => task(),
      () => task(),
    );

    // Advance the tail to a Promise that settles when THIS task settles, but never
    // rejects (so the lane keeps moving). The typed result is returned separately.
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await result;
    } finally {
      this.#pending -= 1;
    }
  }
}
