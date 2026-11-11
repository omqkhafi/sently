/**
 * @module
 * Plunk HTTP transport for sently.
 *
 * Plunk's send API targets a single recipient per request. When `options.to`
 * contains multiple addresses, one HTTP request is sent per recipient and
 * results are aggregated into a single {@link SendResult}.
 *
 * @example
 * ```ts
 * import { PlunkTransport } from "sently/transports/plunk";
 * import { createMailer } from "sently/mailer";
 *
 * const mailer = await createMailer({
 *   transport: new PlunkTransport({ apiKey: process.env.PLUNK_API_KEY! }),
 * });
 * ```
 */

import { extractEmails, parseAddresses } from "../core/address.js";
import { httpStatusToSentlyCode, SentlyError } from "../core/errors.js";
import { providerFetch, readJsonBody } from "../core/http.js";
import type { MailOptions, SendResult, Transport, VerifyResult } from "../core/types.js";

/** Plunk HTTP API configuration. */
export interface PlunkConfig {
  /** Plunk API key for Bearer authentication. */
  apiKey: string;
}

/** Error thrown when the Plunk API returns a non-success response. */
export class PlunkError extends SentlyError {
  /** Creates a Plunk API error with status code. */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly apiError: unknown,
  ) {
    super(message, httpStatusToSentlyCode(statusCode), {
      statusCode,
      provider: "plunk",
      cause: apiError,
    });
    this.name = "PlunkError";
  }
}

/**
 * Plunk HTTP API transport.
 */
export class PlunkTransport implements Transport {
  readonly provider = "plunk";

  private readonly apiKey: string;

  /** Creates a Plunk transport with the given API key. */
  constructor(config: PlunkConfig) {
    this.apiKey = config.apiKey;
  }

  /** Sends an email via the Plunk HTTP API (one request per recipient). */
  async send(options: MailOptions): Promise<SendResult> {
    const from = parseAddresses(options.from)[0];
    const recipients = extractEmails(options.to);
    const bodyContent = options.html ?? options.text ?? "";
    const messageIds: string[] = [];
    const responses: string[] = [];

    for (const recipient of recipients) {
      const response = await providerFetch("https://api.useplunk.com/v1/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: recipient,
          subject: options.subject,
          body: bodyContent,
          subscribed: false,
        }),
      });

      const payload = (await readJsonBody(response, "plunk")) as {
        success?: boolean;
        emails?: Array<{ id?: string; email?: string }>;
        message?: string;
      };

      if (!response.ok || payload.success !== true) {
        throw new PlunkError(payload.message ?? "Plunk API error", response.status, payload);
      }

      const emailId = payload.emails?.[0]?.id ?? "";
      if (emailId) {
        messageIds.push(emailId);
      }
      responses.push(emailId || "sent");
    }

    return {
      messageId: messageIds.join(","),
      accepted: recipients,
      rejected: [],
      response: responses.join("; "),
      envelope: {
        from: from?.address ?? "",
        to: recipients,
      },
    };
  }

  /**
   * Returns success without a network call — Plunk has no documented verify endpoint.
   */
  async verify(): Promise<VerifyResult> {
    return {
      ok: true,
      provider: "plunk",
      message: "no verify endpoint; key not validated",
    };
  }
}
