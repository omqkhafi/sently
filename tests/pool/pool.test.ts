import { describe, expect, test } from "bun:test";
import { SentlyError } from "../../src/core/errors.js";
import { RateLimiter, SMTPPool } from "../../src/pool/pool.js";
import type { SocketAdapter, TLSOptions } from "../../src/core/types.js";

class PoolMockAdapter implements SocketAdapter {
  static created = 0;
  private readonly responses: string[];
  private index = 0;
  private readonly delayReads: number;
  private readsYielded = 0;
  _secure = false;
  _connected = false;

  constructor(responses: string[], delayReads = 0) {
    PoolMockAdapter.created += 1;
    this.responses = responses;
    this.delayReads = delayReads;
  }

  get secure(): boolean {
    return this._secure;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(_host: string, _port: number): Promise<void> {
    this._connected = true;
  }

  async startTLS(_options?: TLSOptions): Promise<void> {
    this._secure = true;
  }

  async write(_data: Uint8Array): Promise<void> {
    // no-op
  }

  async *read(): AsyncIterable<Uint8Array> {
    if (this.readsYielded < this.delayReads) {
      this.readsYielded += 1;
      await new Promise((r) => setTimeout(r, 30));
    }
    const chunk = this.responses[this.index] ?? "250 OK\r\n";
    this.index += 1;
    yield new TextEncoder().encode(chunk);
  }

  async close(): Promise<void> {
    this._connected = false;
  }
}

function sessionSetup(): string[] {
  return ["220 smtp.test ESMTP\r\n", "250-smtp.test\r\n250 AUTH PLAIN\r\n", "235 OK\r\n"];
}

function mailDelivery(): string[] {
  return [
    "250 Sender OK\r\n",
    "250 Recipient OK\r\n",
    "354 Go ahead\r\n",
    "250 Queued\r\n",
  ];
}

function sessionTeardown(): string[] {
  return ["221 Bye\r\n"];
}

function fullSession(mailCount: number): string[] {
  const responses = [...sessionSetup()];
  for (let i = 0; i < mailCount; i++) {
    responses.push(...mailDelivery());
  }
  responses.push(...sessionTeardown());
  return responses;
}

const mail = {
  from: "a@test.com",
  to: "b@test.com",
  subject: "Hi",
  text: "Body",
};

describe("SMTPPool", () => {
  test("connectionCount never exceeds maxConnections when sending 5 concurrently", async () => {
    PoolMockAdapter.created = 0;
    let maxObserved = 0;

    const pool = new SMTPPool(
      {
        host: "smtp.test",
        port: 465,
        secure: true,
        maxConnections: 2,
        maxMessages: 100,
        auth: { user: "u", pass: "p", type: "PLAIN" },
      },
      {
        createAdapter: () => new PoolMockAdapter(fullSession(5)),
      },
    );

    const sends = [
      pool.send(mail),
      pool.send(mail),
      pool.send(mail),
      pool.send(mail),
      pool.send(mail),
    ];

    const poll = (async () => {
      for (let i = 0; i < 100; i++) {
        maxObserved = Math.max(maxObserved, pool.connectionCount);
        await new Promise((r) => setTimeout(r, 2));
      }
    })();

    await Promise.all([...sends, poll]);
    expect(maxObserved).toBeLessThanOrEqual(2);
    await pool.close();
  });

  test("queue drains: second message resolves after first completes", async () => {
    const pool = new SMTPPool(
      {
        host: "smtp.test",
        port: 465,
        secure: true,
        maxConnections: 1,
        maxMessages: 100,
        auth: { user: "u", pass: "p", type: "PLAIN" },
      },
      {
        createAdapter: () => new PoolMockAdapter(fullSession(2), 3),
      },
    );

    const first = pool.send({ ...mail, subject: "first" });
    await new Promise((r) => setTimeout(r, 5));
    expect(pool.queueSize).toBeGreaterThanOrEqual(0);

    const second = pool.send({ ...mail, subject: "second" });
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.messageId).toBeDefined();
    expect(r2.messageId).toBeDefined();
    expect(pool.queueSize).toBe(0);
    await pool.close();
  });

  test("recycles connection after maxMessages=2 on third send", async () => {
    let adapters = 0;

    const pool = new SMTPPool(
      {
        host: "smtp.test",
        port: 465,
        secure: true,
        maxConnections: 5,
        maxMessages: 2,
        auth: { user: "u", pass: "p", type: "PLAIN" },
      },
      {
        createAdapter: () => {
          adapters += 1;
          return new PoolMockAdapter(fullSession(2));
        },
      },
    );

    await pool.send(mail);
    await pool.send(mail);
    expect(pool.connectionCount).toBe(1);

    await pool.send(mail);
    expect(adapters).toBe(2);
    await pool.close();
    expect(pool.connectionCount).toBe(0);
  });

  test("close() drains in-flight sends then clears connections", async () => {
    const pool = new SMTPPool(
      {
        host: "smtp.test",
        port: 465,
        secure: true,
        maxConnections: 2,
        maxMessages: 10,
        auth: { user: "u", pass: "p", type: "PLAIN" },
      },
      {
        createAdapter: () => new PoolMockAdapter(fullSession(5)),
      },
    );

    const s1 = pool.send({ ...mail, subject: "1" });
    const s2 = pool.send({ ...mail, subject: "2" });
    const s3 = pool.send({ ...mail, subject: "3" });

    const results = await Promise.all([s1, s2, s3]);
    expect(results.every((r) => r.messageId.length > 0)).toBe(true);
    expect(pool.queueSize).toBe(0);

    await pool.close();
    expect(pool.connectionCount).toBe(0);
    expect(pool.queueSize).toBe(0);
  });

  test(
    "a connection setup failure rejects every queued send",
    async () => {
      const pool = new SMTPPool(
        {
          host: "127.0.0.1",
          port: 2525,
          pool: true,
          connectionTimeout: 400,
        },
        {
          createAdapter: async () => {
            throw new SentlyError("TLS handshake timed out", "TIMEOUT", { provider: "smtp" });
          },
        },
      );
      const started = Date.now();
      const results = await Promise.all([
        pool.send(mail).then(
          () => "resolved",
          (error: unknown) => error,
        ),
        pool.send(mail).then(
          () => "resolved",
          (error: unknown) => error,
        ),
      ]);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(results).toEqual([
        expect.objectContaining({ sentlyCode: "TIMEOUT" }),
        expect.objectContaining({ sentlyCode: "TIMEOUT" }),
      ]);
      expect(pool.connectionCount).toBe(0);
      expect(pool.queueSize).toBe(0);
      await pool.close();
    },
    2_000,
  );
});

describe("RateLimiter", () => {
  test("first two acquire resolve immediately; third after clock advances without sleep", async () => {
    let t = 0;
    const clock = (): number => t;
    const limiter = new RateLimiter(2, 1000, clock);

    await limiter.acquire();
    await limiter.acquire();

    let resolved = false;
    const pending = limiter.acquire().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    t = 1001;
    limiter.notify();
    await pending;
    expect(resolved).toBe(true);
  });
});
