/**
 * @module
 * RetryTransport — decorator that wraps any sently channel transport
 * and retries failed sends with configurable backoff.
 * Works with email, SMS, WhatsApp, and push transports.
 *
 * @example
 * ```ts
 * import { RetryTransport } from 'sently/transports/retry'
 * import { ResendTransport } from 'sently/transports/resend'
 *
 * const transport = new RetryTransport(
 *   new ResendTransport({ apiKey }),
 *   { maxAttempts: 3, backoff: 'exponential', retryOn: [429, 503] }
 * )
 * ```
 */
import type { DecoratedTransport } from "../core/decorated-transport.js";
import { SentlyError } from "../core/errors.js";
import { invokeHook } from "../core/hooks.js";
import { sendHookSlot } from "../core/send-context.js";
import type { MailOptions, RetryConfig, SendResult, VerifyResult } from "../core/types.js";

/** Upper bound on a single backoff delay. */
const DEFAULT_MAX_DELAY_MS = 60_000;

const DEFAULT_RETRY_ON = [429, 500, 502, 503, 504];

function computeDelay(attempt: number, backoff: string, base: number, maxDelay: number): number {
  let delay = base;
  if (backoff === "exponential") {
    delay = base * 2 ** (attempt - 1);
  } else if (backoff === "linear") {
    delay = base * attempt;
  }
  return Math.min(delay, maxDelay);
}

function shouldRetry(err: unknown, retryOn: number[]): boolean {
  if (
    err instanceof SentlyError &&
    (err.sentlyCode === "SMTP_AUTH_FAILED" ||
      err.sentlyCode === "BAD_REQUEST" ||
      err.sentlyCode === "INVALID_CONFIG")
  ) {
    return false;
  }

  if (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    typeof (err as { statusCode: unknown }).statusCode === "number"
  ) {
    return retryOn.includes((err as { statusCode: number }).statusCode);
  }

  return true;
}

/**
 * Decorator transport that retries failed sends with configurable backoff.
 * Defaults preserve email {@link Transport} compatibility.
 */
export class RetryTransport<TOptions = MailOptions, TResult = SendResult>
  implements DecoratedTransport<TOptions, TResult>
{
  readonly provider = "retry";

  /** Maximum send attempts including the initial try. */
  private readonly maxAttempts: number;
  /** Backoff strategy between retries. */
  private readonly backoff: "exponential" | "linear" | "fixed";
  /** Base delay in milliseconds before the first retry. */
  private readonly baseDelay: number;
  /** Cap on a single backoff delay. */
  private readonly maxDelay: number;
  /** HTTP status codes that trigger a retry. */
  private readonly retryOn: number[];
  /** Optional callback invoked before each retry attempt. */
  private readonly onRetry: RetryConfig["onRetry"];
  /** Additional onRetry callback wired by sender lifecycle hooks per send. */
  private mailerOnRetry: RetryConfig["onRetry"];

  /** Wraps an inner transport with retry logic and optional backoff configuration. */
  constructor(
    /** Transport that performs the actual send on each attempt. */
    private readonly inner: DecoratedTransport<TOptions, TResult>,
    config?: RetryConfig,
    /** Injectable sleep function for testing backoff timing. */
    private readonly _sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    const maxAttempts = config?.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new SentlyError(
        "maxAttempts must be an integer greater than or equal to 1",
        "INVALID_CONFIG",
      );
    }
    this.maxAttempts = maxAttempts;
    this.backoff = config?.backoff ?? "exponential";
    this.baseDelay = config?.baseDelay ?? 1000;
    this.maxDelay = config?.maxDelay ?? DEFAULT_MAX_DELAY_MS;
    this.retryOn = config?.retryOn ?? DEFAULT_RETRY_ON;
    this.onRetry = config?.onRetry;
    this.mailerOnRetry = undefined;
  }

  /**
   * Register a per-send onRetry callback from sender lifecycle hooks.
   * Do not share one {@link RetryTransport} across multiple senders — the last
   * `setMailerOnRetry` wins; overwriting an active callback logs a dev warning.
   * @internal Cleared after each send.
   */
  setMailerOnRetry(callback: RetryConfig["onRetry"] | undefined): void {
    if (
      callback !== undefined &&
      this.mailerOnRetry !== undefined &&
      this.mailerOnRetry !== callback
    ) {
      const isProduction = typeof process !== "undefined" && process.env?.NODE_ENV === "production";
      if (!isProduction) {
        console.warn(
          "[sently] RetryTransport.setMailerOnRetry: overwriting an active mailer onRetry callback. Do not share one RetryTransport instance across multiple senders.",
        );
      }
    }
    this.mailerOnRetry = callback;
  }

  /** Sends with retries according to configured backoff and retry rules. */
  async send(options: TOptions): Promise<TResult> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await this.inner.send(options);
      } catch (err) {
        lastError = err;
        if (attempt === this.maxAttempts) {
          throw err;
        }
        if (!shouldRetry(err, this.retryOn)) {
          throw err;
        }
        const delay = computeDelay(attempt, this.backoff, this.baseDelay, this.maxDelay);
        await invokeHook(this.onRetry, attempt, err);
        const hooked = sendHookSlot.getStore()?.onRetry ?? this.mailerOnRetry;
        await invokeHook(hooked, attempt, err);
        await this._sleep(delay);
      }
    }

    throw lastError;
  }

  /** Delegates to the inner transport verify or returns a default success result. */
  async verify(): Promise<VerifyResult> {
    if (this.inner.verify) {
      return this.inner.verify();
    }
    return { ok: true, provider: "retry" };
  }

  /** Delegates close to the inner transport if available. */
  async close(): Promise<void> {
    await this.inner.close?.();
  }

  /** Delegates batch sends to the inner transport when available. */
  async sendBatch(messages: TOptions[]): Promise<TResult[]> {
    if (this.inner.sendBatch) {
      return this.inner.sendBatch(messages);
    }
    return Promise.all(messages.map((message) => this.send(message)));
  }
}
