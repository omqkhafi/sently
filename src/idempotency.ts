/**
 * @module
 * IdempotencyTransport — decorator that deduplicates sends on retry or replay.
 *
 * Wrap **outside** RetryTransport so all retry attempts share one key:
 *
 * ```ts
 * new IdempotencyTransport(new RetryTransport(inner))
 * ```
 *
 * For production, supply a shared store (Redis, Dragonfly, etc.).
 *
 * @example
 * ```ts
 * import { IdempotencyTransport, MemoryIdempotencyStore } from "sently/idempotency";
 * import { RetryTransport } from "sently/transports/retry";
 * import { ResendTransport } from "sently/transports/resend";
 *
 * const transport = new IdempotencyTransport(
 *   new RetryTransport(new ResendTransport({ apiKey })),
 *   { store: new MemoryIdempotencyStore(), ttlMs: 86_400_000 },
 * );
 * ```
 */
import { extractEmails, parseAddresses } from "./core/address.js";
import { resolveIdempotencyKey } from "./core/idempotency-key.js";
import type { MailOptions, SendResult, Transport, VerifyResult } from "./core/types.js";

/** Key-value store for idempotency deduplication. */
export interface IdempotencyStore {
  /** Returns true when the key was already recorded. */
  has(key: string): Promise<boolean>;
  /** Record a key, optionally expiring after `ttlMs` milliseconds. */
  set(key: string, ttlMs?: number): Promise<void>;
}

/** In-memory idempotency store with optional TTL expiry. Suitable for single-process use. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, number>();

  /** Returns true when the key exists and has not expired. */
  async has(key: string): Promise<boolean> {
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt <= Date.now()) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  /** Record a key with optional TTL in milliseconds. */
  async set(key: string, ttlMs?: number): Promise<void> {
    const expiresAt = ttlMs !== undefined ? Date.now() + ttlMs : Number.POSITIVE_INFINITY;
    this.entries.set(key, expiresAt);
  }
}

/** Options for {@link IdempotencyTransport}. */
export interface IdempotencyTransportOptions {
  /** Store used to track sent keys. Defaults to {@link MemoryIdempotencyStore}. */
  store?: IdempotencyStore;
  /** TTL in milliseconds for recorded keys. Default: 24 hours. */
  ttlMs?: number;
}

function syntheticDedupedResult(options: MailOptions): SendResult {
  const from = parseAddresses(options.from)[0];
  const to = [
    ...extractEmails(options.to),
    ...(options.cc ? extractEmails(options.cc) : []),
    ...(options.bcc ? extractEmails(options.bcc) : []),
  ];

  return {
    messageId: options.messageId ?? "",
    accepted: extractEmails(options.to),
    rejected: [],
    response: "Deduped — idempotency key already recorded",
    envelope: {
      from: from?.address ?? "",
      to,
    },
    deduped: true,
  };
}

/**
 * Transport decorator that skips duplicate sends when an idempotency key
 * was already recorded. Checks the store once before delegating to the inner
 * transport, so retries inside RetryTransport reuse the same key automatically.
 */
export class IdempotencyTransport implements Transport {
  readonly provider = "idempotency";

  private readonly store: IdempotencyStore;
  private readonly ttlMs: number;
  /** In-flight send promises keyed so concurrent callers share one attempt. */
  private readonly inflight = new Map<string, Promise<SendResult>>();

  /** Wraps an inner transport with idempotency deduplication. */
  constructor(
    /** Transport that performs the actual send when the key is new. */
    private readonly inner: Transport,
    options?: IdempotencyTransportOptions,
  ) {
    this.store = options?.store ?? new MemoryIdempotencyStore();
    this.ttlMs = options?.ttlMs ?? 86_400_000;
  }

  /** Sends once per idempotency key; returns a synthetic result on duplicate keys. */
  async send(options: MailOptions): Promise<SendResult> {
    const key = resolveIdempotencyKey(options);
    if (key === undefined) {
      return this.inner.send(options);
    }

    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }

    const work = (async (): Promise<SendResult> => {
      if (await this.store.has(key)) {
        return syntheticDedupedResult(options);
      }
      const result = await this.inner.send(options);
      await this.store.set(key, this.ttlMs);
      return result;
    })();

    this.inflight.set(key, work);
    try {
      return await work;
    } finally {
      if (this.inflight.get(key) === work) {
        this.inflight.delete(key);
      }
    }
  }

  /**
   * Honours the idempotency store for every message.
   * Duplicates do not call the inner transport.
   */
  async sendBatch(messages: MailOptions[]): Promise<SendResult[]> {
    return Promise.all(messages.map((message) => this.send(message)));
  }

  /** Delegates to the inner transport verify or returns a default success result. */
  async verify(): Promise<VerifyResult> {
    if (this.inner.verify) {
      return this.inner.verify();
    }
    return { ok: true, provider: "idempotency" };
  }

  /** Delegates close to the inner transport if available. */
  async close(): Promise<void> {
    await this.inner.close?.();
  }
}
