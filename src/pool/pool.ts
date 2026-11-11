/**
 * @module
 * SMTP connection pool with optional rate limiting.
 *
 * @example
 * ```ts
 * import { SMTPPool } from "sently/pool";
 * import { NodeAdapter } from "sently/adapters/node";
 *
 * const pool = new SMTPPool({
 *   host: "smtp.example.com",
 *   auth: { user: "you@example.com", pass: "secret" },
 *   adapter: new NodeAdapter(),
 *   pool: true,
 *   maxConnections: 5,
 * });
 *
 * await pool.send({
 *   from: "you@example.com",
 *   to: "recipient@example.com",
 *   subject: "Hello",
 *   text: "Pooled send",
 * });
 * ```
 */

import { RateLimiter } from "../core/rate-limiter.js";
import type {
  MailOptions,
  PoolConfig,
  SendResult,
  SMTPConfig,
  SocketAdapter,
  Transport,
  VerifyResult,
} from "../core/types.js";
import { resolveSMTPConfig } from "../transports/smtp.js";
import { createPooledConnection, type PooledConnection } from "./connection.js";

/** Options for {@link SMTPPool}. */
export interface SMTPPoolOptions {
  /** Factory for a new socket adapter per pooled connection. */
  createAdapter?: () => Promise<SocketAdapter> | SocketAdapter;
  /** Injectable clock for rate limiting (testing). */
  now?: () => number;
}

interface QueueEntry {
  options: MailOptions;
  resolve: (result: SendResult) => void;
  reject: (error: unknown) => void;
}

/**
 * SMTP connection pool with optional rate limiting.
 */
export class SMTPPool implements Transport {
  /** Resolved SMTP and pool configuration. */
  private readonly config: SMTPConfig & PoolConfig;
  /** Maximum simultaneous pooled connections. */
  private readonly maxConnections: number;
  /** Maximum messages per connection before recycle. */
  private readonly maxMessages: number;
  /** Factory that creates a socket adapter for each new connection. */
  private readonly createAdapterFn: () => Promise<SocketAdapter>;
  /** Optional token-bucket rate limiter, or null when disabled. */
  private readonly rateLimiter: RateLimiter | null;
  /** Active pooled SMTP connections. */
  private readonly connections: PooledConnection[] = [];
  /** Pending send operations waiting for a connection. */
  private readonly queue: QueueEntry[] = [];
  /** True while {@link close} is draining; rejects new sends. */
  private draining = false;
  /** True after the pool has fully closed. */
  private closed = false;
  /** Serializes queue processing to avoid concurrent drain races. */
  private processChain: Promise<void> = Promise.resolve();

  /** Creates an SMTP connection pool. */
  constructor(config: SMTPConfig & PoolConfig, options?: SMTPPoolOptions) {
    this.config = config;
    this.maxConnections = config.maxConnections ?? 5;
    this.maxMessages = config.maxMessages ?? 100;

    if (options?.createAdapter) {
      const factory = options.createAdapter;
      this.createAdapterFn = async () => factory();
    } else if (config.adapter) {
      this.createAdapterFn = async () => config.adapter as SocketAdapter;
    } else {
      throw new Error("SMTPPool requires config.adapter or options.createAdapter");
    }

    if (config.rateDelta !== undefined && config.rateDelta > 0) {
      this.rateLimiter = new RateLimiter(config.rateDelta, config.rateLimit ?? 1000, options?.now);
    } else {
      this.rateLimiter = null;
    }
  }

  /** Sends a message through the pool. */
  async send(options: MailOptions): Promise<SendResult> {
    if (this.draining) {
      throw new Error("SMTPPool is closing — no new messages accepted");
    }
    if (this.closed) {
      throw new Error("SMTPPool is closed");
    }
    if (this.rateLimiter) {
      await this.rateLimiter.acquire();
    }
    return new Promise<SendResult>((resolve, reject) => {
      this.queue.push({ options, resolve, reject });
      this.scheduleProcess();
    });
  }

  /** Schedules asynchronous processing of the send queue. */
  private scheduleProcess(): void {
    this.processChain = this.processChain
      .then(() => this.processQueue())
      .catch((error: unknown) => {
        const pending = this.queue.splice(0, this.queue.length);
        for (const entry of pending) {
          entry.reject(error);
        }
      });
  }

  /** Verifies connectivity using a temporary connection. */
  async verify(): Promise<VerifyResult> {
    try {
      const conn = await this.spawnConnection();
      try {
        return { ok: true, provider: "smtp-pool" };
      } finally {
        await conn.close();
        this.removeConnection(conn);
      }
    } catch (err) {
      return {
        ok: false,
        provider: "smtp-pool",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Drains the queue and closes all connections. */
  async close(): Promise<void> {
    this.draining = true;
    await this.drainQueue();
    await Promise.allSettled(this.connections.map((c) => c.close()));
    this.connections.length = 0;
    this.closed = true;
  }

  /** Current number of open pooled connections. */
  get connectionCount(): number {
    return this.connections.length;
  }

  /** Number of messages waiting in the send queue. */
  get queueSize(): number {
    return this.queue.length;
  }

  /** Dispatches queued messages to idle or newly spawned connections. */
  private async processQueue(): Promise<void> {
    if (this.draining) {
      return;
    }

    while (this.queue.length > 0) {
      const idleConn = this.connections.find((c) => c.idle && c.usable);
      if (idleConn) {
        const entry = this.queue.shift();
        if (!entry) {
          break;
        }
        try {
          const result = await idleConn.send(entry.options);
          entry.resolve(result);
          if (!idleConn.usable) {
            await idleConn.close();
            this.removeConnection(idleConn);
          }
        } catch (err) {
          entry.reject(err);
          await idleConn.close().catch(() => undefined);
          this.removeConnection(idleConn);
        }
        continue;
      }

      if (this.connections.length < this.maxConnections) {
        const entry = this.queue.shift();
        if (!entry) {
          break;
        }
        let conn: PooledConnection | undefined;
        try {
          conn = await this.spawnConnection();
          const result = await conn.send(entry.options);
          entry.resolve(result);
          if (!conn.usable) {
            await conn.close();
            this.removeConnection(conn);
          }
        } catch (err) {
          entry.reject(err);
          if (conn) {
            await conn.close().catch(() => undefined);
            this.removeConnection(conn);
          }
        }
        continue;
      }

      break;
    }
  }

  /** Opens a new authenticated pooled SMTP connection. */
  private async spawnConnection(): Promise<PooledConnection> {
    const resolved = resolveSMTPConfig(this.config);
    const conn = await createPooledConnection({
      config: this.config,
      maxMessages: this.maxMessages,
      connectHost: resolved.host,
      createAdapter: this.createAdapterFn,
    });
    this.connections.push(conn);
    return conn;
  }

  /** Removes a connection from the active pool list. */
  private removeConnection(conn: PooledConnection): void {
    const index = this.connections.indexOf(conn);
    if (index >= 0) {
      this.connections.splice(index, 1);
    }
  }

  /** Waits until the send queue and in-flight work are fully drained. */
  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0 || this.connections.some((c) => !c.idle)) {
      await this.processQueue();
      if (this.queue.length > 0) {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  }
}

/** @internal Exposed for deterministic rate limiter tests. */
export { RateLimiter } from "../core/rate-limiter.js";
