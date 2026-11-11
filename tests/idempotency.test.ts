import { describe, expect, test } from "bun:test";
import type { MailOptions, SendResult, Transport } from "../src/core/types.js";
import { IdempotencyTransport, MemoryIdempotencyStore } from "../src/idempotency.js";
import { RetryTransport } from "../src/transports/retry.js";
import { ResendTransport } from "../src/transports/resend.js";

const baseOptions: MailOptions = {
  from: "sender@example.com",
  to: "recipient@example.com",
  subject: "Test",
  text: "Body",
};

const successResult: SendResult = {
  messageId: "<test@example.com>",
  accepted: ["recipient@example.com"],
  rejected: [],
  response: "250 OK",
  envelope: { from: "sender@example.com", to: ["recipient@example.com"] },
};

describe("IdempotencyTransport", () => {
  test("duplicate key skips the second real send", async () => {
    let calls = 0;
    const inner: Transport = {
      send: async () => {
        calls++;
        return successResult;
      },
    };

    const transport = new IdempotencyTransport(inner, {
      store: new MemoryIdempotencyStore(),
    });

    const first = await transport.send({ ...baseOptions, idempotencyKey: "key-1" });
    const second = await transport.send({ ...baseOptions, idempotencyKey: "key-1" });

    expect(calls).toBe(1);
    expect(first.deduped).toBeUndefined();
    expect(second.deduped).toBe(true);
    expect(second.response).toContain("Deduped");
  });

  test("RetryTransport reuses one key and sends exactly once on success", async () => {
    let calls = 0;
    const inner: Transport = {
      send: async () => {
        calls++;
        if (calls === 1) {
          throw new Error("transient");
        }
        return successResult;
      },
    };

    const transport = new IdempotencyTransport(
      new RetryTransport(inner, { maxAttempts: 3 }, () => Promise.resolve()),
      { store: new MemoryIdempotencyStore() },
    );

    const result = await transport.send({ ...baseOptions, idempotencyKey: "retry-key" });

    expect(calls).toBe(2);
    expect(result.deduped).toBeUndefined();
    expect(result.messageId).toBe(successResult.messageId);
  });

  test("derives key from messageId when idempotencyKey is absent", async () => {
    let calls = 0;
    const inner: Transport = {
      send: async () => {
        calls++;
        return successResult;
      },
    };

    const transport = new IdempotencyTransport(inner);
    await transport.send({ ...baseOptions, messageId: "<msg-123@example.com>" });
    await transport.send({ ...baseOptions, messageId: "<msg-123@example.com>" });

    expect(calls).toBe(1);
  });

  test("ResendTransport sends Idempotency-Key header", async () => {
    const originalFetch = globalThis.fetch;
    let capturedHeaders: HeadersInit | undefined;

    globalThis.fetch = (async (_input, init) => {
      capturedHeaders = init?.headers;
      return Response.json({ id: "resend-1" }, { status: 200 });
    }) as typeof fetch;

    try {
      const transport = new ResendTransport({ apiKey: "re_test" });
      await transport.send({ ...baseOptions, idempotencyKey: "idem-abc" });

      expect(capturedHeaders).toMatchObject({
        Authorization: "Bearer re_test",
        "Idempotency-Key": "idem-abc",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("concurrent sends with one key share a single inner send", async () => {
    let calls = 0;
    const inner: Transport = {
      send: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return successResult;
      },
    };
    const transport = new IdempotencyTransport(inner, {
      store: new MemoryIdempotencyStore(),
    });
    const message = { ...baseOptions, idempotencyKey: "same" };
    const results = await Promise.all([
      transport.send(message),
      transport.send(message),
      transport.send(message),
    ]);
    expect(calls).toBe(1);
    expect(results).toHaveLength(3);
  });
});
