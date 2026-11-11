/**
 * Integration checks — every published subpath resolves and core v0.8 APIs behave end-to-end.
 * Imports `dist/` after a build and falls back to `src/` so `bun test` works on a fresh clone.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import type { MailOptions, SendResult, Transport } from "../../src/core/types.js";

const distReady = existsSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js"));

/** Prefer the built entry when it exists; otherwise load the TypeScript source. */
function modPath(distPath: string): string {
  if (distReady) {
    return distPath;
  }
  return distPath.replace("../../dist/", "../../src/").replace(/\.js$/, ".ts");
}

const baseMessage: MailOptions = {
  from: "sender@example.com",
  to: "recipient@example.com",
  subject: "API surface",
  text: "Body",
};

const successResult: SendResult = {
  messageId: "<api@test.com>",
  accepted: ["recipient@example.com"],
  rejected: [],
  response: "OK",
  envelope: { from: "sender@example.com", to: ["recipient@example.com"] },
};

/** Published subpaths from package.json (dist after build). */
const subpathImports: Array<{ path: string; check: (mod: Record<string, unknown>) => void }> = [
  {
    path: "../../dist/index.js",
    check: (mod) => {
      expect(mod.createMailer).toBeDefined();
      expect(mod.FallbackTransport).toBeDefined();
      expect(mod.WeightedFallbackTransport).toBeDefined();
      expect(mod.CloudflareEmailTransport).toBeDefined();
      expect(mod.toChannelSendResult).toBeDefined();
    },
  },
  {
    path: "../../dist/channel-result.js",
    check: (mod) => expect(mod.toChannelSendResult).toBeDefined(),
  },
  {
    path: "../../dist/mailer.js",
    check: (mod) => expect(mod.createMailer).toBeDefined(),
  },
  {
    path: "../../dist/smtp-mailer.js",
    check: (mod) => expect(mod.createSMTPMailer).toBeDefined(),
  },
  {
    path: "../../dist/transports/fallback.js",
    check: (mod) => {
      expect(mod.FallbackTransport).toBeDefined();
      expect(mod.FallbackError).toBeDefined();
    },
  },
  {
    path: "../../dist/transports/weighted-fallback.js",
    check: (mod) => expect(mod.WeightedFallbackTransport).toBeDefined(),
  },
  {
    path: "../../dist/transports/cloudflare-email.js",
    check: (mod) => {
      expect(mod.CloudflareEmailTransport).toBeDefined();
      expect(mod.CloudflareEmailError).toBeDefined();
    },
  },
  {
    path: "../../dist/transports/resend.js",
    check: (mod) => expect(mod.ResendTransport).toBeDefined(),
  },
  {
    path: "../../dist/transports/mailersend.js",
    check: (mod) => expect(mod.MailerSendTransport).toBeDefined(),
  },
  {
    path: "../../dist/transports/plunk.js",
    check: (mod) => expect(mod.PlunkTransport).toBeDefined(),
  },
  {
    path: "../../dist/transports/sparkpost.js",
    check: (mod) => expect(mod.SparkPostTransport).toBeDefined(),
  },
  {
    path: "../../dist/transports/mailtrap.js",
    check: (mod) => expect(mod.MailtrapTransport).toBeDefined(),
  },
  {
    path: "../../dist/transports/mailpit.js",
    check: (mod) => {
      expect(mod.MailpitTransport).toBeDefined();
      expect(mod.MailpitError).toBeDefined();
    },
  },
  {
    path: "../../dist/transports/inbucket.js",
    check: (mod) => {
      expect(mod.InbucketTransport).toBeDefined();
      expect(mod.InbucketError).toBeDefined();
    },
  },
  {
    path: "../../dist/transports/loops.js",
    check: (mod) => expect(mod.LoopsTransport).toBeDefined(),
  },
  {
    path: "../../dist/transports/sndr.js",
    check: (mod) => {
      expect(mod.SndrTransport).toBeDefined();
      expect(mod.SndrError).toBeDefined();
    },
  },
  {
    path: "../../dist/transports/hostinger.js",
    check: (mod) => {
      expect(mod.HostingerTransport).toBeDefined();
      expect(mod.HostingerError).toBeDefined();
      expect(mod.hostingerSmtpConfig).toBeDefined();
      expect(mod.HOSTINGER_SMTP_HOST).toBe("smtp.hostinger.com");

      expect(mod.HostingerTransport({ token: "t", mailbox: "m" }).provider).toBe("hostinger");
      expect(mod.HostingerTransport({ user: "u", pass: "p" })).toMatchObject({
        host: "smtp.hostinger.com",
        secure: true,
      });
    },
  },
  {
    path: "../../dist/webhooks.js",
    check: (mod) => {
      expect(mod.parseResendWebhook).toBeDefined();
      expect(mod.parseSndrWebhook).toBeDefined();
      expect(mod.verifySndrSignature).toBeDefined();
      expect(mod.parseTwilioSmsWebhook).toBeDefined();
      expect(mod.parseWhatsAppCloudWebhook).toBeDefined();
      expect(mod.parseUnifonicWebhook).toBeDefined();
      expect(mod.toDeliveryEvent).toBeDefined();
    },
  },
  {
    path: "../../dist/transports/unifonic.js",
    check: (mod) => expect(mod.UnifonicTransport).toBeDefined(),
  },
  {
    path: "../../dist/transports/fcm.js",
    check: (mod) => expect(mod.FcmTransport).toBeDefined(),
  },
  {
    path: "../../dist/webhooks/twilio-sms.js",
    check: (mod) => {
      expect(mod.parse).toBeDefined();
      expect(mod.verifySignature).toBeDefined();
    },
  },
  {
    path: "../../dist/webhooks/whatsapp-cloud.js",
    check: (mod) => {
      expect(mod.parse).toBeDefined();
      expect(mod.verifySignature).toBeDefined();
    },
  },

  {
    path: "../../dist/webhooks/sndr.js",
    check: (mod) => {
      expect(mod.parse).toBeDefined();
      expect(mod.verifySignature).toBeDefined();
    },
  },
  {
    path: "../../dist/webhooks/resend.js",
    check: (mod) => {
      expect(mod.parse).toBeDefined();
      expect(mod.verifySignature).toBeDefined();
    },
  },
  {
    path: "../../dist/observability/console.js",
    check: (mod) => expect(mod.consoleObserver).toBeDefined(),
  },
  {
    path: "../../dist/idempotency.js",
    check: (mod) => expect(mod.IdempotencyTransport).toBeDefined(),
  },
];

describe("published API surface (dist)", () => {
  for (const { path, check } of subpathImports) {
    test(`${path} resolves and exports expected symbols`, async () => {
      const mod = (await import(modPath(path))) as Record<string, unknown>;
      check(mod);
    });
  }
});

describe("v0.8 API behavior", () => {
  test("FallbackTransport.verifyAll + verify() agree on first healthy provider", async () => {
    const { FallbackTransport } = await import(modPath("../../dist/transports/fallback.js"));
    const primary: Transport = {
      provider: "primary",
      verify: async () => ({ ok: false, provider: "primary" }),
      send: async () => successResult,
    };
    const backup: Transport = {
      provider: "backup",
      verify: async () => ({ ok: true, provider: "backup", message: "ok" }),
      send: async () => ({ ...successResult, messageId: "<backup@test.com>" }),
    };

    const transport = new FallbackTransport([primary, backup]);
    const all = await transport.verifyAll();
    const single = await transport.verify();

    expect(all.ok).toBe(true);
    expect(all.providers).toHaveLength(2);
    expect(single.ok).toBe(true);
    expect(single.provider).toBe("backup");
  });

  test("WeightedFallbackTransport.verify() delegates to inner chain", async () => {
    const { WeightedFallbackTransport } = await import(
      modPath("../../dist/transports/weighted-fallback.js"),
    );
    const inner: Transport = {
      provider: "only",
      verify: async () => ({ ok: true, provider: "only" }),
      send: async () => successResult,
    };

    const transport = new WeightedFallbackTransport([{ transport: inner, weight: 1 }]);
    const result = await transport.verify();
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("only");
  });

  test("createMailer wires onFallback through dist mailer bundle", async () => {
    const { createMailer } = await import(modPath("../../dist/mailer.js"));
    const { FallbackTransport } = await import(modPath("../../dist/transports/fallback.js"));
    const { ResendError } = await import(modPath("../../dist/transports/resend.js"));

    const events: string[] = [];
    const primary: Transport = {
      provider: "resend",
      send: async () => {
        throw new ResendError("down", 503, {});
      },
    };
    const backup: Transport = {
      provider: "ses",
      send: async () => successResult,
    };

    const mailer = await createMailer({
      transport: new FallbackTransport([primary, backup]),
      hooks: {
        onFallback: (_ctx, failed, next) => {
          events.push(`${failed}->${next}`);
        },
      },
    });

    await mailer.send(baseMessage);
    expect(events).toEqual(["resend->ses"]);
  });

  test("CloudflareEmailTransport from dist sends through binding", async () => {
    const { CloudflareEmailTransport } = await import(
      modPath("../../dist/transports/cloudflare-email.js"),
    );

    let sent = false;
    const transport = new CloudflareEmailTransport({
      sendEmail: async () => {
        sent = true;
      },
    });

    await transport.send(baseMessage);
    expect(sent).toBe(true);
    expect(transport.provider).toBe("cloudflare-email");
  });

  test("createMailer.verify() delegates to FallbackTransport.verify()", async () => {
    const { createMailer } = await import(modPath("../../dist/mailer.js"));
    const { FallbackTransport } = await import(modPath("../../dist/transports/fallback.js"));

    const primary: Transport = {
      provider: "primary",
      verify: async () => ({ ok: false, provider: "primary" }),
      send: async () => successResult,
    };
    const backup: Transport = {
      provider: "backup",
      verify: async () => ({ ok: true, provider: "backup", message: "ready" }),
      send: async () => successResult,
    };

    const mailer = await createMailer({
      transport: new FallbackTransport([primary, backup]),
    });

    const result = await mailer.verify();
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("backup");
  });

  test("FallbackOptions.onFallback and mailer onFallback can both fire", async () => {
    const { createMailer } = await import(modPath("../../dist/mailer.js"));
    const { FallbackTransport } = await import(modPath("../../dist/transports/fallback.js"));
    const { ResendError } = await import(modPath("../../dist/transports/resend.js"));

    const transportEvents: number[] = [];
    const mailerEvents: string[] = [];

    const primary: Transport = {
      provider: "resend",
      send: async () => {
        throw new ResendError("down", 503, {});
      },
    };
    const backup: Transport = {
      provider: "ses",
      send: async () => successResult,
    };

    const transport = new FallbackTransport([primary, backup], {
      onFallback: (index) => {
        transportEvents.push(index);
      },
    });

    const mailer = await createMailer({
      transport,
      hooks: {
        onFallback: (_ctx, failed, next) => {
          mailerEvents.push(`${failed}->${next}`);
        },
      },
    });

    await mailer.send(baseMessage);
    expect(transportEvents).toEqual([0]);
    expect(mailerEvents).toEqual(["resend->ses"]);
  });

  test("consoleObserver returns usable hooks from dist", async () => {
    const { consoleObserver } = await import(modPath("../../dist/observability/console.js"));
    const hooks = consoleObserver("[test]");
    expect(typeof hooks.onSend).toBe("function");
    expect(typeof hooks.onSuccess).toBe("function");
    expect(typeof hooks.onError).toBe("function");
  });
});
