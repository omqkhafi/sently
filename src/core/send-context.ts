/**
 * @module
 * Per-send hook slot so concurrent sends do not share one callback field.
 *
 * `node:async_hooks` is imported on the first send, not at module load.
 * When that module is missing, the slot is copied at the start of the send
 * so retry and fallback still see the hooks for that call.
 */

/** Hooks bound to the send that is currently running. */
export interface SendHookSlot {
  /** Retry hook for this send. */
  onRetry?: (attempt: number, error: unknown) => void | Promise<void>;
  /** Fallback hook for this send. */
  onFallback?: (
    failedProvider: string,
    nextProvider: string,
    error: unknown,
  ) => void | Promise<void>;
}

/** Storage that keeps a slot across `await` when the runtime provides it. */
interface HookStorage {
  /** Slot for the active send, if one is running. */
  getStore(): SendHookSlot | undefined;
  /**
   * Run `fn` with `slot` visible to {@link getStore}.
   *
   * @param slot - Hooks for this send
   * @param fn - Send body
   */
  run<T>(slot: SendHookSlot, fn: () => T): T;
}

let storage: HookStorage | undefined;
let loading: Promise<HookStorage> | undefined;
let fallbackCurrent: SendHookSlot | undefined;

function fallbackStorage(): HookStorage {
  return {
    getStore: () => fallbackCurrent,
    run(slot, fn) {
      const previous = fallbackCurrent;
      fallbackCurrent = slot;
      try {
        return fn();
      } finally {
        fallbackCurrent = previous;
      }
    },
  };
}

async function loadStorage(): Promise<HookStorage> {
  if (storage) {
    return storage;
  }
  loading ??= (async () => {
    try {
      const specifier = "node:async_hooks";
      const mod = (await import(specifier)) as {
        AsyncLocalStorage: new () => HookStorage;
      };
      storage = new mod.AsyncLocalStorage();
    } catch {
      storage = fallbackStorage();
    }
    return storage;
  })();
  return loading;
}

/**
 * Ambient slot for the active send.
 * Prefer {@link runWithSendHooks}, which loads storage before the send starts.
 */
export const sendHookSlot: HookStorage = {
  getStore() {
    return storage?.getStore() ?? fallbackCurrent;
  },
  run(slot, fn) {
    return (storage ?? fallbackStorage()).run(slot, fn);
  },
};

/**
 * Run `fn` with a send-scoped hook slot.
 *
 * @param slot - Hooks for this send
 * @param fn - Send body
 */
export async function runWithSendHooks<T>(slot: SendHookSlot, fn: () => Promise<T>): Promise<T> {
  const active = await loadStorage();
  return active.run(slot, fn);
}
