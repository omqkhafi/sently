/**
 * @module
 * MailerSend HTTP transport for sently.
 *
 * @example
 * ```ts
 * import { MailerSendTransport } from "sently/transports/mailersend";
 * import { createMailer } from "sently/mailer";
 *
 * const mailer = await createMailer({
 *   transport: new MailerSendTransport({ apiToken: process.env.MAILERSEND_API_TOKEN! }),
 * });
 * ```
 */

import { extractEmails, parseAddresses } from "../core/address.js";
import { encodeBase64 } from "../core/base64.js";
import { httpStatusToSentlyCode, SentlyError } from "../core/errors.js";
import { providerFetch } from "../core/http.js";
import type { MailOptions, SendResult, Transport, VerifyResult } from "../core/types.js";
import { resolveAttachments } from "./resolve-attachments.js";

/** MailerSend HTTP API configuration. */
export interface MailerSendConfig {
  /** MailerSend API token for Bearer authentication. */
  apiToken: string;
}

/** Error thrown when the MailerSend API returns a non-success response. */
export class MailerSendError extends SentlyError {
  /** Creates a MailerSend API error with status code. */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly apiError: unknown,
  ) {
    super(message, httpStatusToSentlyCode(statusCode), {
      statusCode,
      provider: "mailersend",
      cause: apiError,
    });
    this.name = "MailerSendError";
  }
}

function toAddressObjects(input: MailOptions["to"]): Array<{ email: string; name?: string }> {
  return parseAddresses(input).map((addr) => ({
    email: addr.address,
    ...(addr.name ? { name: addr.name } : {}),
  }));
}

/**
 * MailerSend HTTP API transport.
 */
export class MailerSendTransport implements Transport {
  readonly provider = "mailersend";

  private readonly apiToken: string;

  /** Creates a MailerSend transport with the given API token. */
  constructor(config: MailerSendConfig) {
    this.apiToken = config.apiToken;
  }

  /** Sends an email via the MailerSend HTTP API. */
  async send(options: MailOptions): Promise<SendResult> {
    const attachments = await resolveAttachments(options.attachments);
    const from = parseAddresses(options.from)[0];

    const body: Record<string, unknown> = {
      from: from
        ? { email: from.address, ...(from.name ? { name: from.name } : {}) }
        : { email: "" },
      to: toAddressObjects(options.to),
      subject: options.subject,
      ...(options.cc ? { cc: toAddressObjects(options.cc) } : {}),
      ...(options.bcc ? { bcc: toAddressObjects(options.bcc) } : {}),
      ...(options.replyTo
        ? {
            reply_to: (() => {
              const reply = parseAddresses(options.replyTo as MailOptions["to"])[0];
              return reply
                ? { email: reply.address, ...(reply.name ? { name: reply.name } : {}) }
                : undefined;
            })(),
          }
        : {}),
      ...(options.text ? { text: options.text } : {}),
      ...(options.html ? { html: options.html } : {}),
      ...(attachments.length > 0
        ? {
            attachments: attachments.map((att) => ({
              filename: att.filename,
              content:
                att.content instanceof Uint8Array
                  ? encodeBase64(att.content).replace(/\r\n/g, "")
                  : att.content,
              disposition: "attachment",
            })),
          }
        : {}),
    };

    const response = await providerFetch("https://api.mailersend.com/v1/email", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
        errors?: unknown;
      };
      throw new MailerSendError(
        payload.message ?? "MailerSend API error",
        response.status,
        payload,
      );
    }

    const messageId = response.headers.get("x-message-id") ?? "";
    const toEmails = extractEmails(options.to);

    return {
      messageId,
      accepted: toEmails,
      rejected: [],
      response: messageId || "accepted",
      envelope: {
        from: from?.address ?? "",
        to: toEmails,
      },
    };
  }

  /** Verifies the MailerSend API token by listing domains. */
  async verify(): Promise<VerifyResult> {
    try {
      const response = await providerFetch("https://api.mailersend.com/v1/domains", {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        return {
          ok: false,
          provider: "mailersend",
          message: payload.message ?? `HTTP ${response.status}`,
        };
      }

      return { ok: true, provider: "mailersend", message: "API token is valid" };
    } catch (err) {
      return {
        ok: false,
        provider: "mailersend",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
