/**
 * @module
 * Deadline helper shared by direct and pooled SMTP sends.
 */
import { SentlyError } from "./errors.js";

/**
 * Race `promise` against a deadline.
 *
 * A `timeoutMs` of `0` or less waits without a deadline. On expiry, or when
 * `promise` rejects with `TIMEOUT`, `onTimeout` runs before the error is rethrown.
 *
 * @param promise - Work to bound
 * @param timeoutMs - Deadline in milliseconds
 * @param message - Timeout error message
 * @param onTimeout - Abort in-flight I/O so the work can settle
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout: () => Promise<void> | void,
): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new SentlyError(message, "TIMEOUT", { provider: "smtp" }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch (error) {
    if (error instanceof SentlyError && error.sentlyCode === "TIMEOUT") {
      await Promise.resolve(onTimeout()).catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
