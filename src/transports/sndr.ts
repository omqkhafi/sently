/**
 * @module
 * SNDR HTTP API transport for sending email via api.sndr.sh.
 *
 * Aligned with the official SNDR API / `@rkiza/sndr` SDK:
 * `POST /v1/send` with Bearer auth and optional `Idempotency-Key`.
 *
 * @see https://www.sndr.sh/docs/api-reference
 *
 * @example
 * ```ts
 * import { SndrTransport } from "sently/transports/sndr";
 * import { createMailer } from "sently/mailer";
 *
 * const mailer = await createMailer({
 *   transport: new SndrTransport({ apiKey: process.env.SNDR_API_KEY! }),
 * });
 *
 * await mailer.send({
 *   from: "hello@yourdomain.com",
 *   to: "customer@example.com",
 *   subject: "Welcome aboard",
 *   html: "<p>Thanks for joining us.</p>",
 * });
 * ```
 */

import { extractEmails, parseAddresses, toMIMEHeader } from "../core/address.js";
import { httpStatusToSentlyCode, SentlyError } from "../core/errors.js";
import { providerFetch } from "../core/http.js";
import { resolveIdempotencyKey } from "../core/idempotency-key.js";
import type { MailOptions, SendResult, Transport, VerifyResult } from "../core/types.js";

/** Header for a per-message SNDR template ID (`template_id`). */
export const SNDR_TEMPLATE_ID_HEADER = "x-sndr-template-id";

/** SNDR API configuration. */
export interface SndrConfig {
  /**
   * SNDR API key (starts with `sndr_live_` or `sndr_test_`).
   * Store in environment variables — never hardcode.
   */
  apiKey: string;
  /** API base URL. Default: `https://api.sndr.sh`. */
  baseUrl?: string;
  /**
   * Default SNDR template ID when not set per message via
   * {@link SNDR_TEMPLATE_ID_HEADER}.
   */
  defaultTemplateId?: string;
}

/** Error thrown when the SNDR API returns a non-success response. */
export class SndrError extends SentlyError {
  /** Creates an SNDR API error with status code and response payload. */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly apiError: unknown,
  ) {
    super(message, httpStatusToSentlyCode(statusCode), {
      statusCode,
      provider: "sndr",
      cause: apiError,
    });
    this.name = "SndrError";
  }
}

/**
 * SNDR HTTP API transport.
 */
export class SndrTransport implements Transport {
  readonly provider = "sndr";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultTemplateId?: string;

  /** Creates an SNDR transport with the given API key. */
  constructor(config: SndrConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://api.sndr.sh").replace(/\/+$/, "");
    if (config.defaultTemplateId !== undefined) {
      this.defaultTemplateId = config.defaultTemplateId;
    }
  }

  /** Sends an email via `POST /v1/send`. */
  async send(options: MailOptions): Promise<SendResult> {
    const from = parseAddresses(options.from)[0];
    const to = extractEmails(options.to);
    const templateId = options.headers?.[SNDR_TEMPLATE_ID_HEADER] ?? this.defaultTemplateId;

    const body: Record<string, unknown> = {
      from: from ? toMIMEHeader(from) : "",
      to,
      subject: options.subject,
      ...(options.cc ? { cc: extractEmails(options.cc) } : {}),
      ...(options.bcc ? { bcc: extractEmails(options.bcc) } : {}),
      ...(options.replyTo
        ? {
            reply_to: (() => {
              const reply = parseAddresses(options.replyTo as MailOptions["to"])[0];
              return reply?.address;
            })(),
          }
        : {}),
      ...(options.html ? { html: options.html } : {}),
      ...(options.text ? { text: options.text } : {}),
      ...(templateId ? { template_id: templateId } : {}),
      ...(templateId && options.data ? { variables: options.data } : {}),
    };

    if (options.headers) {
      const headers = Object.fromEntries(
        Object.entries(options.headers).filter(([key]) => key !== SNDR_TEMPLATE_ID_HEADER),
      );
      if (Object.keys(headers).length > 0) {
        body.headers = headers;
      }
    }

    // Drop undefined reply_to when parse failed.
    if (body.reply_to === undefined) {
      delete body.reply_to;
    }

    const idempotencyKey = resolveIdempotencyKey(options);

    const response = await providerFetch(`${this.baseUrl}/v1/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      id?: string;
      status?: string;
      error?: { code?: string; message?: string; request_id?: string };
      message?: string;
    };

    if (!response.ok) {
      throw new SndrError(
        payload.error?.message ?? payload.message ?? "SNDR API error",
        response.status,
        payload,
      );
    }

    const fromAddress = from?.address ?? "";
    return {
      messageId: payload.id ?? options.messageId ?? "",
      accepted: to,
      rejected: [],
      response: payload.status ?? payload.id ?? "queued",
      envelope: {
        from: fromAddress,
        to: [
          ...to,
          ...(options.cc ? extractEmails(options.cc) : []),
          ...(options.bcc ? extractEmails(options.bcc) : []),
        ],
      },
    };
  }

  /** Verifies the API key by listing domains (`GET /v1/domains`). */
  async verify(): Promise<VerifyResult> {
    try {
      const response = await providerFetch(`${this.baseUrl}/v1/domains`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
          message?: string;
        };
        return {
          ok: false,
          provider: "sndr",
          message: payload.error?.message ?? payload.message ?? `HTTP ${response.status}`,
        };
      }

      return { ok: true, provider: "sndr", message: "API key is valid" };
    } catch (err) {
      return {
        ok: false,
        provider: "sndr",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
