/**
 * @module
 * SendGrid v3 HTTP API transport for sending email via api.sendgrid.com.
 *
 * @example
 * ```ts
 * import { SendGridTransport } from "sently/transports/sendgrid";
 * import { createMailer } from "sently/mailer";
 *
 * const mailer = await createMailer({
 *   transport: new SendGridTransport({ apiKey: process.env.SENDGRID_API_KEY! }),
 * });
 *
 * await mailer.send({
 *   from: "sender@example.com",
 *   to: "recipient@example.com",
 *   subject: "Hello",
 *   text: "Plain text body",
 * });
 * ```
 */

import { extractEmails, parseAddresses } from "../core/address.js";
import { encodeBase64 } from "../core/base64.js";
import { httpStatusToSentlyCode, SentlyError } from "../core/errors.js";
import { providerFetch, readJsonBody } from "../core/http.js";
import type { MailOptions, SendResult, Transport, VerifyResult } from "../core/types.js";
import { resolveAttachments } from "./resolve-attachments.js";

/** SendGrid API configuration. */
export interface SendGridConfig {
  /** SendGrid API key (Bearer token). */
  apiKey: string;
}

/** Error thrown when the SendGrid API returns a non-success response. */
export class SendGridError extends SentlyError {
  /** Creates a SendGrid API error with status code and response payload. */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly apiError: unknown,
  ) {
    super(message, httpStatusToSentlyCode(statusCode), {
      statusCode,
      provider: "sendgrid",
      cause: apiError,
    });
    this.name = "SendGridError";
  }
}

/**
 * SendGrid v3 HTTP API transport.
 */
export class SendGridTransport implements Transport {
  readonly provider = "sendgrid";

  /** SendGrid API key for Bearer authentication. */
  private readonly apiKey: string;

  /** Creates a SendGrid transport with the given API key. */
  constructor(config: SendGridConfig) {
    this.apiKey = config.apiKey;
  }

  /** Build a SendGrid personalization for one message. */
  private buildPersonalization(options: MailOptions): Record<string, unknown> {
    return {
      to: parseAddresses(options.to).map((addr) => ({ email: addr.address, name: addr.name })),
      ...(options.cc
        ? {
            cc: parseAddresses(options.cc).map((addr) => ({
              email: addr.address,
              name: addr.name,
            })),
          }
        : {}),
      ...(options.bcc
        ? {
            bcc: parseAddresses(options.bcc).map((addr) => ({
              email: addr.address,
              name: addr.name,
            })),
          }
        : {}),
      subject: options.subject,
      ...(options.headers ? { headers: options.headers } : {}),
    };
  }

  /** Build SendGrid content parts from text/html options. */
  private buildContent(options: MailOptions): Array<{ type: string; value: string }> {
    return [
      ...(options.text ? [{ type: "text/plain", value: options.text }] : []),
      ...(options.html ? [{ type: "text/html", value: options.html }] : []),
    ];
  }

  /** Map a SendGrid response to a normalized SendResult for one message. */
  private toSendResult(
    options: MailOptions,
    messageId: string,
    responseText = "Accepted",
  ): SendResult {
    const from = parseAddresses(options.from)[0];
    return {
      messageId,
      accepted: extractEmails(options.to),
      rejected: [],
      response: responseText,
      envelope: {
        from: from?.address ?? "",
        to: [
          ...extractEmails(options.to),
          ...(options.cc ? extractEmails(options.cc) : []),
          ...(options.bcc ? extractEmails(options.bcc) : []),
        ],
      },
    };
  }

  /** Sends an email via the SendGrid v3 HTTP API. */
  async send(options: MailOptions): Promise<SendResult> {
    const attachments = await resolveAttachments(options.attachments);
    const from = parseAddresses(options.from)[0];

    const body = {
      personalizations: [this.buildPersonalization(options)],
      from: from
        ? { email: from.address, ...(from.name ? { name: from.name } : {}) }
        : { email: "" },
      ...(options.replyTo
        ? {
            reply_to: parseAddresses(options.replyTo).map((addr) => ({
              email: addr.address,
              name: addr.name,
            }))[0],
          }
        : {}),
      content: this.buildContent(options),
      ...(attachments.length > 0
        ? {
            attachments: attachments.map((att) => ({
              filename: att.filename,
              type: att.contentType ?? "application/octet-stream",
              content:
                att.content instanceof Uint8Array
                  ? encodeBase64(att.content).replace(/\r\n/g, "")
                  : att.content,
              ...(att.contentId ? { content_id: att.contentId } : {}),
              disposition: att.inline ? "inline" : "attachment",
            })),
          }
        : {}),
    };

    const response = await providerFetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const apiError = await response.text();
      throw new SendGridError("SendGrid API error", response.status, apiError);
    }

    const messageId = response.headers.get("x-message-id") ?? options.messageId ?? "";

    return this.toSendResult(options, messageId);
  }

  /** Send multiple messages in one request using SendGrid personalizations. */
  async sendBatch(messages: MailOptions[]): Promise<SendResult[]> {
    if (messages.length === 0) {
      return [];
    }

    const first = messages[0] as MailOptions;
    const from = parseAddresses(first.from)[0];

    const body = {
      personalizations: messages.map((message) => this.buildPersonalization(message)),
      from: from
        ? { email: from.address, ...(from.name ? { name: from.name } : {}) }
        : { email: "" },
      ...(first.replyTo
        ? {
            reply_to: parseAddresses(first.replyTo).map((addr) => ({
              email: addr.address,
              name: addr.name,
            }))[0],
          }
        : {}),
      content: this.buildContent(first),
    };

    const response = await providerFetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const apiError = await response.text();
      throw new SendGridError("SendGrid API error", response.status, apiError);
    }

    const messageId = response.headers.get("x-message-id") ?? "";
    return messages.map((message) =>
      this.toSendResult(message, messageId || message.messageId || ""),
    );
  }

  /** Verifies the SendGrid API key by fetching the user profile. */
  async verify(): Promise<VerifyResult> {
    try {
      const response = await providerFetch("https://api.sendgrid.com/v3/user/profile", {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        const apiError = await response.text().catch(() => "");
        return {
          ok: false,
          provider: "sendgrid",
          message: apiError || `HTTP ${response.status}`,
        };
      }

      const payload = (await readJsonBody(response, "sendgrid")) as { username?: string };
      return {
        ok: true,
        provider: "sendgrid",
        ...(payload.username ? { message: payload.username } : {}),
      };
    } catch (err) {
      return {
        ok: false,
        provider: "sendgrid",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
