/**
 * @module
 * Mailgun HTTP transport for sently.
 * Uses the Mailgun Messages API v3 with multipart/form-data.
 *
 * @example
 * ```ts
 * import { MailgunTransport } from "sently/transports/mailgun";
 * import { createMailer } from "sently/mailer";
 *
 * const mailer = await createMailer({
 *   transport: new MailgunTransport({
 *     apiKey: "key-...",
 *     domain: "mg.example.com",
 *   }),
 * });
 * ```
 */

import { extractEmails, parseAddresses, toMIMEHeader } from "../core/address.js";
import { encodeBase64 } from "../core/base64.js";
import { httpStatusToSentlyCode, SentlyError } from "../core/errors.js";
import { providerFetch, readJsonBody } from "../core/http.js";
import type {
  MailgunConfig,
  MailOptions,
  SendResult,
  Transport,
  VerifyResult,
} from "../core/types.js";
import { resolveAttachments } from "./resolve-attachments.js";

/** Error thrown when the Mailgun API returns a non-success response. */
export class MailgunError extends SentlyError {
  /** Creates a Mailgun API error with status code and response payload. */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly apiError: unknown,
  ) {
    super(message, httpStatusToSentlyCode(statusCode), {
      statusCode,
      provider: "mailgun",
      cause: apiError,
    });
    this.name = "MailgunError";
  }
}

/**
 * Mailgun HTTP API transport (multipart/form-data).
 */
export class MailgunTransport implements Transport {
  readonly provider = "mailgun";

  /** Mailgun API key for basic authentication. */
  private readonly apiKey: string;
  /** Mailgun sending domain. */
  private readonly domain: string;
  /** Mailgun API base URL (US or EU region). */
  private readonly baseUrl: string;

  /** Creates a Mailgun transport with the given API key and domain. */
  constructor(config: MailgunConfig) {
    this.apiKey = config.apiKey;
    this.domain = config.domain;
    this.baseUrl =
      config.region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
  }

  /** Sends an email via the Mailgun Messages API. */
  async send(options: MailOptions): Promise<SendResult> {
    const attachments = await resolveAttachments(options.attachments);
    const from = parseAddresses(options.from)[0];
    const form = new FormData();

    form.append("from", from ? toMIMEHeader(from) : "");
    form.append("to", parseAddresses(options.to).map(toMIMEHeader).join(", "));

    if (options.cc) {
      form.append("cc", parseAddresses(options.cc).map(toMIMEHeader).join(", "));
    }
    if (options.bcc) {
      form.append("bcc", parseAddresses(options.bcc).map(toMIMEHeader).join(", "));
    }

    form.append("subject", options.subject);

    if (options.text) {
      form.append("text", options.text);
    }
    if (options.html) {
      form.append("html", options.html);
    }
    if (options.replyTo) {
      const replyTo = parseAddresses(options.replyTo)[0];
      if (replyTo) {
        form.append("h:Reply-To", toMIMEHeader(replyTo));
      }
    }

    for (const attachment of attachments) {
      const content =
        attachment.content instanceof Uint8Array
          ? attachment.content
          : new TextEncoder().encode(String(attachment.content ?? ""));
      const blob = new Blob([new Uint8Array(content)], {
        type: attachment.contentType ?? "application/octet-stream",
      });
      form.append("attachment", blob, attachment.filename);
    }

    const auth = encodeBase64(`api:${this.apiKey}`).replace(/\r\n/g, "");
    const response = await providerFetch(`${this.baseUrl}/v3/${this.domain}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
      },
      body: form,
    });

    const payload = (await readJsonBody(response, "mailgun")) as { id?: string; message?: string };

    if (!response.ok) {
      throw new MailgunError(payload.message ?? "Mailgun API error", response.status, payload);
    }

    const toEmails = extractEmails(options.to);
    return {
      messageId: payload.id ?? "",
      accepted: toEmails,
      rejected: [],
      response: payload.message ?? "queued",
      envelope: {
        from: from?.address ?? "",
        to: toEmails,
      },
    };
  }

  /** Verifies the Mailgun API key by listing domains. */
  async verify(): Promise<VerifyResult> {
    try {
      const auth = encodeBase64(`api:${this.apiKey}`).replace(/\r\n/g, "");
      const response = await providerFetch(`${this.baseUrl}/v3/domains`, {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        return {
          ok: false,
          provider: "mailgun",
          message: payload.message ?? `HTTP ${response.status}`,
        };
      }

      return { ok: true, provider: "mailgun", message: "API key is valid" };
    } catch (err) {
      return {
        ok: false,
        provider: "mailgun",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
