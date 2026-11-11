import { describe, expect, test } from "bun:test";
import type { MailOptions, SendResult, Transport } from "../../src/core/types.js";
import { createMailer } from "../../src/mailer.js";

const successResult = (subject: string): SendResult => ({
  messageId: `<${subject}@example.com>`,
  accepted: ["recipient@example.com"],
  rejected: [],
  response: "250 OK",
  envelope: { from: "sender@example.com", to: ["recipient@example.com"] },
});

function message(subject: string): MailOptions {
  return {
    from: "sender@example.com",
    to: "recipient@example.com",
    subject,
    text: "Body",
  };
}

describe("sendBulk", () => {
  test("all messages sent, results in input order", async () => {
    const transport: Transport = {
      send: async (options) => successResult(options.subject),
    };
    const mailer = await createMailer({ transport });

    const result = await mailer.sendBulk([
      message("First"),
      message("Second"),
      message("Third"),
    ]);

    expect(result.total).toBe(3);
    expect(result.sent).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.results[0]?.status).toBe("sent");
    expect(result.results[1]?.status).toBe("sent");
    expect(result.results[2]?.status).toBe("sent");
    if (result.results[0]?.status === "sent") {
      expect(result.results[0].result.messageId).toBe("<First@example.com>");
    }
    if (result.results[2]?.status === "sent") {
      expect(result.results[2].result.messageId).toBe("<Third@example.com>");
    }
  });

  test("failed message captured in results, batch continues", async () => {
    const transport: Transport = {
      send: async (options) => {
        if (options.subject === "Fail") {
          throw new Error("send failed");
        }
        return successResult(options.subject);
      },
    };
    const mailer = await createMailer({ transport });

    const result = await mailer.sendBulk([message("OK"), message("Fail"), message("Also OK")]);

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results[0]?.status).toBe("sent");
    expect(result.results[1]?.status).toBe("failed");
    expect(result.results[2]?.status).toBe("sent");
    if (result.results[1]?.status === "failed") {
      expect(result.results[1].error).toBeInstanceOf(Error);
    }
  });

  test("onSuccess called for each successful send", async () => {
    const successes: string[] = [];
    const transport: Transport = {
      send: async (options) => successResult(options.subject),
    };
    const mailer = await createMailer({ transport });

    await mailer.sendBulk([message("A"), message("B")], {
      onSuccess: (msg) => {
        successes.push(msg.subject);
      },
    });

    expect(successes).toEqual(["A", "B"]);
  });

  test("onError called for each failed send without throwing", async () => {
    const errors: string[] = [];
    const transport: Transport = {
      send: async (options) => {
        if (options.subject === "Bad") {
          throw new Error("bad");
        }
        return successResult(options.subject);
      },
    };
    const mailer = await createMailer({ transport });

    await expect(
      mailer.sendBulk([message("Good"), message("Bad")], {
        onError: (msg) => {
          errors.push(msg.subject);
        },
      }),
    ).resolves.toBeDefined();

    expect(errors).toEqual(["Bad"]);
  });

  test("concurrency 2 — max 2 in-flight at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const transport: Transport = {
      send: async (options) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
        return successResult(options.subject);
      },
    };
    const mailer = await createMailer({ transport });

    await mailer.sendBulk(
      [message("1"), message("2"), message("3"), message("4")],
      { concurrency: 2 },
    );

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBe(2);
  });

  test("a throwing onSuccess still counts the message as sent", async () => {
    const transport: Transport = {
      send: async (options) => successResult(options.subject),
    };
    const mailer = await createMailer({ transport });
    const result = await mailer.sendBulk([message("One"), message("Two")], {
      onSuccess: () => {
        throw new Error("hook failed");
      },
    });
    expect(result.sent).toBe(2);
    expect(result.results.every((entry) => entry.status === "sent")).toBe(true);
  });

  test("rejects a non-positive concurrency", async () => {
    const transport: Transport = {
      send: async (options) => successResult(options.subject),
    };
    const mailer = await createMailer({ transport });
    await expect(mailer.sendBulk([message("One")], { concurrency: 0 })).rejects.toMatchObject({
      sentlyCode: "INVALID_CONFIG",
    });
    await expect(mailer.sendBulk([message("One")], { concurrency: Number.NaN })).rejects.toMatchObject(
      { sentlyCode: "INVALID_CONFIG" },
    );
  });

  test("empty array returns zero counts", async () => {
    const transport: Transport = {
      send: async (options) => successResult(options.subject),
    };
    const mailer = await createMailer({ transport });

    const result = await mailer.sendBulk([]);

    expect(result).toEqual({
      total: 0,
      sent: 0,
      failed: 0,
      results: [],
    });
  });
});
