/**
 * @module
 * Per-send hook slot so concurrent sends do not share one callback field.
 */
import { AsyncLocalStorage } from "node:async_hooks";

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

/** Ambient slot for the active send. */
export const sendHookSlot = new AsyncLocalStorage<SendHookSlot>();

/**
 * Run `fn` with a send-scoped hook slot.
 *
 * @param slot - Hooks for this send
 * @param fn - Send body
 */
export function runWithSendHooks<T>(slot: SendHookSlot, fn: () => Promise<T>): Promise<T> {
  return sendHookSlot.run(slot, fn);
}
