/**
 * @module
 * SparkPost HTTP transport for sently.
 *
 * v1 simplification: all `to`, `cc`, and `bcc` addresses are placed in
 * `recipients[]` without SparkPost `header_to` handling for cc/bcc routing.
 *
 * @example
 * ```ts
 * import { SparkPostTransport } from "sently/transports/sparkpost";
 * import { createMailer } from "sently/mailer";
 *
 * const mailer = await createMailer({
 *   transport: new SparkPostTransport({ apiKey: process.env.SPARKPOST_API_KEY! }),
 * });
 * ```
 */

import { extractEmails, parseAddresses, toMIMEHeader } from "../core/address.js";
import { encodeBase64 } from "../core/base64.js";
import { httpStatusToSentlyCode, SentlyError } from "../core/errors.js";
import { providerFetch, readJsonBody } from "../core/http.js";
import type { MailOptions, SendResult, Transport, VerifyResult } from "../core/types.js";
import { resolveAttachments } from "./resolve-attachments.js";

/** SparkPost HTTP API configuration. */
export interface SparkPostConfig {
  /** SparkPost API key (raw key — no Bearer prefix). */
  apiKey: string;
  /** When true, use the EU API host (`api.eu.sparkpost.com`). */
  euRegion?: boolean;
}

/** Error thrown when the SparkPost API returns a non-success response. */
export class SparkPostError extends SentlyError {
  /** Creates a SparkPost API error with status code and error details. */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly errors: unknown,
  ) {
    super(message, httpStatusToSentlyCode(statusCode), {
      statusCode,
      provider: "sparkpost",
      cause: errors,
    });
    this.name = "SparkPostError";
  }
}

function toRecipients(options: MailOptions): Array<{ address: { email: string; name?: string } }> {
  const addresses = [
    ...parseAddresses(options.to),
    ...(options.cc ? parseAddresses(options.cc) : []),
    ...(options.bcc ? parseAddresses(options.bcc) : []),
  ];

  return addresses.map((addr) => ({
    address: {
      email: addr.address,
      ...(addr.name ? { name: addr.name } : {}),
    },
  }));
}

/**
 * SparkPost HTTP API transport.
 */
export class SparkPostTransport implements Transport {
  readonly provider = "sparkpost";

  private readonly apiKey: string;
  private readonly baseUrl: string;

  /** Creates a SparkPost transport with the given API key. */
  constructor(config: SparkPostConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.euRegion ? "https://api.eu.sparkpost.com" : "https://api.sparkpost.com";
  }

  /** Sends an email via the SparkPost transmissions API. */
  async send(options: MailOptions): Promise<SendResult> {
    const attachments = await resolveAttachments(options.attachments);
    const from = parseAddresses(options.from)[0];

    const content: Record<string, unknown> = {
      from: from ? toMIMEHeader(from) : "",
      subject: options.subject,
      ...(options.html ? { html: options.html } : {}),
      ...(options.text ? { text: options.text } : {}),
      ...(options.replyTo ? { reply_to: extractEmails(options.replyTo)[0] } : {}),
      ...(attachments.length > 0
        ? {
            attachments: attachments.map((att) => ({
              type: att.contentType ?? "application/octet-stream",
              name: att.filename,
              data:
                att.content instanceof Uint8Array
                  ? encodeBase64(att.content).replace(/\r\n/g, "")
                  : att.content,
            })),
          }
        : {}),
    };

    const body = {
      content,
      recipients: toRecipients(options),
    };

    const response = await providerFetch(`${this.baseUrl}/api/v1/transmissions`, {
      method: "POST",
      headers: {
        Authorization: this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const payload = (await readJsonBody(response, "sparkpost")) as {
      results?: { id?: string; total_accepted_recipients?: number };
      errors?: unknown;
      message?: string;
    };

    if (!response.ok) {
      throw new SparkPostError(
        payload.message ?? "SparkPost API error",
        response.status,
        payload.errors ?? payload,
      );
    }

    const messageId = payload.results?.id ?? "";
    const toEmails = [
      ...extractEmails(options.to),
      ...(options.cc ? extractEmails(options.cc) : []),
      ...(options.bcc ? extractEmails(options.bcc) : []),
    ];

    return {
      messageId,
      accepted: toEmails,
      rejected: [],
      response: messageId || "sent",
      envelope: {
        from: from?.address ?? "",
        to: toEmails,
      },
    };
  }

  /** Verifies the SparkPost API key by fetching account info. */
  async verify(): Promise<VerifyResult> {
    try {
      const response = await providerFetch(`${this.baseUrl}/api/v1/account`, {
        headers: {
          Authorization: this.apiKey,
        },
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          errors?: Array<{ message?: string }>;
          message?: string;
        };
        const errMsg = payload.errors?.[0]?.message ?? payload.message ?? `HTTP ${response.status}`;
        return {
          ok: false,
          provider: "sparkpost",
          message: errMsg,
        };
      }

      return { ok: true, provider: "sparkpost", message: "API key is valid" };
    } catch (err) {
      return {
        ok: false,
        provider: "sparkpost",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
