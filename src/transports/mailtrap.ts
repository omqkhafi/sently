/**
 * @module
 * Mailtrap HTTP transport for sently.
 *
 * @example
 * ```ts
 * import { MailtrapTransport } from "sently/transports/mailtrap";
 * import { createMailer } from "sently/mailer";
 *
 * const mailer = await createMailer({
 *   transport: new MailtrapTransport({ apiToken: process.env.MAILTRAP_API_TOKEN! }),
 * });
 * ```
 */

import { extractEmails, parseAddresses } from "../core/address.js";
import { encodeBase64 } from "../core/base64.js";
import { httpStatusToSentlyCode, SentlyError } from "../core/errors.js";
import { providerFetch, readJsonBody } from "../core/http.js";
import type { MailOptions, SendResult, Transport, VerifyResult } from "../core/types.js";
import { resolveAttachments } from "./resolve-attachments.js";

/** Mailtrap HTTP API configuration. */
export interface MailtrapConfig {
  /** Mailtrap API token for Bearer authentication. */
  apiToken: string;
  /** When true, use the sandbox send endpoint (requires `inboxId`). */
  sandbox?: boolean;
  /** Sandbox inbox ID — required when `sandbox` is true. */
  inboxId?: string;
}

/** Error thrown when the Mailtrap API returns a non-success response. */
export class MailtrapError extends SentlyError {
  /** Creates a Mailtrap API error with status code. */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly apiError: unknown,
  ) {
    super(message, httpStatusToSentlyCode(statusCode), {
      statusCode,
      provider: "mailtrap",
      cause: apiError,
    });
    this.name = "MailtrapError";
  }
}

function toAddressObjects(input: MailOptions["to"]): Array<{ email: string; name?: string }> {
  return parseAddresses(input).map((addr) => ({
    email: addr.address,
    ...(addr.name ? { name: addr.name } : {}),
  }));
}

/**
 * Mailtrap HTTP API transport.
 */
export class MailtrapTransport implements Transport {
  readonly provider = "mailtrap";

  private readonly apiToken: string;
  private readonly sandbox: boolean;
  private readonly inboxId?: string;

  /** Creates a Mailtrap transport with the given API token. */
  constructor(config: MailtrapConfig) {
    this.apiToken = config.apiToken;
    this.sandbox = config.sandbox ?? false;
    if (config.inboxId !== undefined) {
      this.inboxId = config.inboxId;
    }
  }

  private sendUrl(): string {
    if (this.sandbox) {
      if (!this.inboxId) {
        throw new MailtrapError("Mailtrap sandbox mode requires inboxId", 400, {
          code: "INVALID_CONFIG",
        });
      }
      return `https://sandbox.api.mailtrap.io/api/send/${this.inboxId}`;
    }
    return "https://send.api.mailtrap.io/api/send";
  }

  /** Sends an email via the Mailtrap HTTP API. */
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
              type: att.contentType ?? "application/octet-stream",
            })),
          }
        : {}),
    };

    const response = await providerFetch(this.sendUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const payload = (await readJsonBody(response, "mailtrap")) as {
      success?: boolean;
      message_ids?: string[];
      message?: string;
    };

    if (!response.ok || payload.success !== true) {
      throw new MailtrapError(payload.message ?? "Mailtrap API error", response.status, payload);
    }

    const messageIds = payload.message_ids ?? [];
    const toEmails = extractEmails(options.to);

    return {
      messageId: messageIds.join(","),
      accepted: toEmails,
      rejected: [],
      response: messageIds.join(",") || "sent",
      envelope: {
        from: from?.address ?? "",
        to: toEmails,
      },
    };
  }

  /**
   * Returns success without a network call — Mailtrap has no simple verify endpoint.
   */
  async verify(): Promise<VerifyResult> {
    return {
      ok: true,
      provider: "mailtrap",
      message: "key not validated (no verify endpoint)",
    };
  }
}
