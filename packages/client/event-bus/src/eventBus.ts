/**
 * The typed pub/sub kernel (see the package README).
 *
 * A `TypedEventBus<E>` is generic over a fixed event map `E` (event name → payload type), so `emit`
 * and `on` are compile-time checked against the payload for that name. Dispatch is **isolated**: a
 * handler that throws is caught and logged, so one bad subscriber can't wedge cross-feature
 * orchestration.
 *
 * Deliberately minimal: middleware, a handler registry, payload validation, an async `emitAsync`
 * and a transport are left out (see the package README). Consumers build their app-wide event map
 * and singleton bus from this kernel.
 */

/** A listener for a payload of type `P`. */
export type Listener<P> = (payload: P) => void;

/** Unsubscribe handle returned by `on` — call it to detach the listener. */
export type Unsubscribe = () => void;

/**
 * A minimal typed pub/sub bus over a fixed event map `E` (event name -> payload type). Every feature
 * contributes its `constants/events.ts` names/payloads into an app-wide map, so `emit`/`on` are
 * checked against the intersection.
 */
export class TypedEventBus<E extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof E, Set<Listener<unknown>>>();

  /** Register a handler for `event`; returns an unsubscribe. */
  on<K extends keyof E>(event: K, listener: Listener<E[K]>): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<unknown>);
    return () => this.off(event, listener);
  }

  /** Register a handler that detaches itself after the first emit. */
  once<K extends keyof E>(event: K, listener: Listener<E[K]>): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  /** Remove a previously-registered handler. */
  off<K extends keyof E>(event: K, listener: Listener<E[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<unknown>);
  }

  /**
   * Emit `payload` to every handler of `event`. Handlers are isolated: one that throws does not
   * stop the others (see the header).
   */
  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy so a handler that (un)subscribes during dispatch can't mutate the iterating set.
    for (const listener of [...set]) {
      try {
        (listener as Listener<E[K]>)(payload);
      } catch (err) {
        // Surface, don't swallow, a faulty subscriber (config allows console.error).
        console.error(`[event-bus] listener for "${String(event)}" threw`, err);
      }
    }
  }

  /** Detach all handlers (test teardown / feature disposal). */
  clear(): void {
    this.listeners.clear();
  }
}
