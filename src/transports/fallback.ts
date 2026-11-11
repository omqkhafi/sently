/**
 * @module
 * FallbackTransport — routes through an ordered list of transports,
 * advancing to the next when the current one fails. Use for provider
 * failover across email, SMS, WhatsApp, or push. Composes with
 * RetryTransport — wrap each entry in RetryTransport to retry within a
 * provider before failing over to the next.
 *
 * @example
 * ```ts
 * import { FallbackTransport } from "sently/transports/fallback";
 * import { RetryTransport } from "sently/transports/retry";
 * import { ResendTransport } from "sently/transports/resend";
 * import { SESTransport } from "sently/transports/ses";
 *
 * const transport = new FallbackTransport(
 *   [
 *     new RetryTransport(new ResendTransport({ apiKey })),
 *     new RetryTransport(new SESTransport({ accessKeyId, secretAccessKey })),
 *   ],
 *   { cooldownMs: 300_000 },
 * );
 * ```
 */
import type { DecoratedTransport, FallbackAugmentedResult } from "../core/decorated-transport.js";
import { SentlyError } from "../core/errors.js";
import { getProviderLabel } from "../core/provider-label.js";
import { sendHookSlot } from "../core/send-context.js";
import type { MailOptions, SendResult, VerifyResult } from "../core/types.js";

/** One failed provider attempt collected during failover. */
export interface FallbackAttempt {
  /** Provider label (e.g. `"resend"`, `"ses"`). */
  provider: string;
  /** Error thrown by that transport. */
  error: unknown;
}

/** Per-provider result from {@link FallbackTransport.verifyAll}. */
export interface FallbackProviderVerifyResult {
  /** Provider label. */
  provider: string;
  /** Whether this provider verified successfully. */
  ok: boolean;
  /** Human-readable status from the provider verify call. */
  message?: string;
}

/** Result of verifying every transport in a fallback chain. */
export interface FallbackVerifyAllResult {
  /** True when at least one provider in the chain verified successfully. */
  ok: boolean;
  /** Per-provider verify results in chain order. */
  providers: FallbackProviderVerifyResult[];
}

/** Options for {@link FallbackTransport} failover behavior. */
export interface FallbackOptions {
  /**
   * Decide whether a given error should trigger failover to the next
   * transport. Default: fail over on everything EXCEPT permanent client
   * errors (HTTP 400/401/403, SMTP permanent 5xx auth failures), since
   * those will fail identically on every provider.
   */
  shouldFallback?: (error: unknown) => boolean;
  /** Optional callback fired before advancing to the next transport. */
  onFallback?: (failedIndex: number, error: unknown) => void;
  /**
   * After a failed send, skip this provider until the cooldown expires (ms).
   * Prevents hammering a failing provider during an outage.
   */
  cooldownMs?: number;
  /** Injectable clock for cooldown and testing. Default: `Date.now`. */
  now?: () => number;
  /**
   * Shared cooldown state across fallback instances (e.g. {@link WeightedFallbackTransport}).
   * @internal
   */
  cooldownState?: Map<string, number>;
}

/**
 * Thrown when every transport in the chain fails.
 * {@link FallbackAttempt} entries record which provider failed and why.
 */
export class FallbackError extends Error {
  /** All failed attempts in order — which provider failed and why. */
  readonly attempts: FallbackAttempt[];

  /** Creates an error summarizing every failed transport attempt. */
  constructor(attempts: FallbackAttempt[]) {
    super(`All ${attempts.length} transports failed`);
    this.name = "FallbackError";
    this.attempts = attempts;
  }
}

/** @deprecated Use {@link getProviderLabel} from `sently/core` patterns. */
export const inferProviderLabel = getProviderLabel;

function defaultShouldFallback(error: unknown): boolean {
  if (error instanceof SentlyError && error.sentlyCode === "SMTP_AUTH_FAILED") {
    return false;
  }

  const status = (error as { statusCode?: number })?.statusCode;
  if (typeof status === "number") {
    if (status === 400 || status === 401 || status === 403) {
      return false;
    }
    return true;
  }

  const code = (error as { code?: number })?.code;
  if (code === 535) {
    return false;
  }

  return true;
}

type MailerOnFallback = (
  failedProvider: string,
  nextProvider: string,
  error: unknown,
) => void | Promise<void>;

/**
 * Decorator transport that fails over through an ordered list of transports.
 * Defaults preserve email {@link Transport} compatibility.
 */
export class FallbackTransport<TOptions = MailOptions, TResult = SendResult>
  implements DecoratedTransport<TOptions, FallbackAugmentedResult<TResult>>
{
  readonly provider = "fallback";

  private readonly shouldFallback: (error: unknown) => boolean;
  private readonly onFallback?: FallbackOptions["onFallback"];
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly unhealthyUntil: Map<string, number>;
  private mailerOnFallback: MailerOnFallback | undefined;

  /**
   * Creates a failover transport over an ordered list of backends.
   * @throws {Error} When the transports array is empty.
   */
  constructor(
    private readonly transports: DecoratedTransport<TOptions, TResult>[],
    options?: FallbackOptions,
  ) {
    if (transports.length === 0) {
      throw new Error("FallbackTransport requires at least one transport");
    }
    this.shouldFallback = options?.shouldFallback ?? defaultShouldFallback;
    this.onFallback = options?.onFallback;
    this.cooldownMs = options?.cooldownMs ?? 0;
    this.now = options?.now ?? (() => Date.now());
    this.unhealthyUntil = options?.cooldownState ?? new Map<string, number>();
  }

  /**
   * Register a per-send onFallback callback from sender lifecycle hooks.
   * @internal Cleared after each send.
   */
  setMailerOnFallback(callback: MailerOnFallback | undefined): void {
    this.mailerOnFallback = callback;
  }

  private isCoolingDown(provider: string): boolean {
    const until = this.unhealthyUntil.get(provider);
    if (until === undefined) {
      return false;
    }
    if (this.now() >= until) {
      this.unhealthyUntil.delete(provider);
      return false;
    }
    return true;
  }

  private markUnhealthy(provider: string): void {
    if (this.cooldownMs > 0) {
      this.unhealthyUntil.set(provider, this.now() + this.cooldownMs);
    }
  }

  /** Sends through transports in order until one succeeds. */
  async send(message: TOptions): Promise<FallbackAugmentedResult<TResult>> {
    const attempts: FallbackAttempt[] = [];
    const skipped: FallbackAttempt[] = [];

    for (let i = 0; i < this.transports.length; i++) {
      const transport = this.transports[i] as DecoratedTransport<TOptions, TResult>;
      const provider = getProviderLabel(transport);

      if (this.isCoolingDown(provider)) {
        skipped.push({
          provider,
          error: new Error(`Provider ${provider} is in cooldown`),
        });
        continue;
      }

      try {
        const result = await transport.send(message);
        return {
          ...result,
          provider,
          providerIndex: i,
        };
      } catch (err) {
        attempts.push({ provider, error: err });

        const fallback = this.shouldFallback(err) !== false;
        if (fallback) {
          this.markUnhealthy(provider);
        }

        const nextIndex = this.findNextTryIndex(i);
        if (nextIndex === -1) {
          break;
        }
        if (!fallback) {
          throw err;
        }
        const nextProvider = getProviderLabel(
          this.transports[nextIndex] as DecoratedTransport<TOptions, TResult>,
        );
        this.onFallback?.(i, err);
        const hooked = sendHookSlot.getStore()?.onFallback ?? this.mailerOnFallback;
        if (hooked !== undefined) {
          await hooked(provider, nextProvider, err);
        }
      }
    }

    const allAttempts = [...attempts, ...skipped];
    if (allAttempts.length === 0) {
      throw new FallbackError([
        { provider: "fallback", error: new Error("All providers are in cooldown") },
      ]);
    }

    throw new FallbackError(allAttempts);
  }

  private findNextTryIndex(currentIndex: number): number {
    for (let j = currentIndex + 1; j < this.transports.length; j++) {
      const provider = getProviderLabel(
        this.transports[j] as DecoratedTransport<TOptions, TResult>,
      );
      if (!this.isCoolingDown(provider)) {
        return j;
      }
    }
    return -1;
  }

  /**
   * Returns the result of the first transport whose verify() returns `ok: true`.
   * Use {@link verifyAll} for full-chain visibility.
   */
  async verify(): Promise<VerifyResult> {
    const all = await this.verifyAll();
    const firstOk = all.providers.find((entry) => entry.ok);
    if (firstOk !== undefined) {
      return {
        ok: true,
        provider: firstOk.provider,
        ...(firstOk.message !== undefined ? { message: firstOk.message } : {}),
      };
    }

    return {
      ok: false,
      provider: "fallback",
      message: "no transport verified",
    };
  }

  /** Verifies every transport in the chain and returns per-provider results. */
  async verifyAll(): Promise<FallbackVerifyAllResult> {
    const providers: FallbackProviderVerifyResult[] = [];

    for (const transport of this.transports) {
      const provider = getProviderLabel(transport);
      if (transport.verify === undefined) {
        providers.push({ provider, ok: false, message: "no verify() method" });
        continue;
      }

      try {
        const result = await transport.verify();
        providers.push({
          provider,
          ok: result.ok,
          ...(result.message !== undefined ? { message: result.message } : {}),
        });
      } catch (err) {
        providers.push({
          provider,
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      ok: providers.some((entry) => entry.ok),
      providers,
    };
  }

  /** Calls close() on every transport; one failure does not block the others. */
  async close(): Promise<void> {
    await Promise.allSettled(this.transports.map((transport) => transport.close?.()));
  }
}
