/**
 * @module
 * Loops transactional HTTP transport for sently.
 *
 * Loops is template-first. `subject`, `html`, and `text` are ignored — provide a
 * transactional template ID and data variables instead.
 *
 * Set the template ID per message via the `x-loops-transactional-id` header, or
 * configure a default with `defaultTransactionalId` on the transport constructor.
 * Data variables are read from `options.data`.
 *
 * @example
 * ```ts
 * import { LoopsTransport } from "sently/transports/loops";
 * import { createMailer } from "sently/mailer";
 *
 * const mailer = await createMailer({
 *   transport: new LoopsTransport({ apiKey: process.env.LOOPS_API_KEY! }),
 * });
 *
 * await mailer.send({
 *   from: "noreply@example.com",
 *   to: "user@example.com",
 *   subject: "ignored by Loops",
 *   headers: { "x-loops-transactional-id": "clxxxxxxxx" },
 *   data: { firstName: "Ada" },
 * });
 * ```
 */

import { extractEmails } from "../core/address.js";
import { httpStatusToSentlyCode, SentlyError } from "../core/errors.js";
import { providerFetch, readJsonBody } from "../core/http.js";
import type { MailOptions, SendResult, Transport, VerifyResult } from "../core/types.js";

/** Loops HTTP API configuration. */
export interface LoopsConfig {
  /** Loops API key for Bearer authentication. */
  apiKey: string;
  /** Default transactional template ID when not set per message via header. */
  defaultTransactionalId?: string;
}

/** Error thrown when the Loops API returns a non-success response. */
export class LoopsError extends SentlyError {
  /** Creates a Loops API error with status code. */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly apiError: unknown,
  ) {
    super(message, httpStatusToSentlyCode(statusCode), {
      statusCode,
      provider: "loops",
      cause: apiError,
    });
    this.name = "LoopsError";
  }
}

const TRANSACTIONAL_ID_HEADER = "x-loops-transactional-id";

/**
 * Loops transactional HTTP API transport.
 */
export class LoopsTransport implements Transport {
  readonly provider = "loops";

  private readonly apiKey: string;
  private readonly defaultTransactionalId?: string;

  /** Creates a Loops transport with the given API key. */
  constructor(config: LoopsConfig) {
    this.apiKey = config.apiKey;
    if (config.defaultTransactionalId !== undefined) {
      this.defaultTransactionalId = config.defaultTransactionalId;
    }
  }

  /** Sends a transactional email via the Loops HTTP API. */
  async send(options: MailOptions): Promise<SendResult> {
    const transactionalId =
      options.headers?.[TRANSACTIONAL_ID_HEADER] ?? this.defaultTransactionalId;

    if (!transactionalId) {
      throw new LoopsError(
        "Loops requires a transactional template ID. Set options.headers['x-loops-transactional-id'] or LoopsConfig.defaultTransactionalId. Loops cannot send raw subject/html/text.",
        400,
        { code: "MISSING_TRANSACTIONAL_ID" },
      );
    }

    const recipient = extractEmails(options.to)[0];
    if (!recipient) {
      throw new LoopsError("Loops requires at least one recipient in options.to", 400, {
        code: "MISSING_RECIPIENT",
      });
    }

    const body = {
      transactionalId,
      email: recipient,
      dataVariables: options.data ?? {},
    };

    const response = await providerFetch("https://app.loops.so/api/v1/transactional", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const payload = (await readJsonBody(response, "loops")) as {
      success?: boolean;
      id?: string;
      message?: string;
    };

    if (!response.ok || payload.success === false) {
      throw new LoopsError(payload.message ?? "Loops API error", response.status, payload);
    }

    return {
      messageId: payload.id ?? "",
      accepted: [recipient],
      rejected: [],
      response: payload.id ?? "sent",
      envelope: {
        from: extractEmails(options.from)[0] ?? "",
        to: [recipient],
      },
    };
  }

  /**
   * Returns success without a network call — Loops has no simple verify endpoint.
   */
  async verify(): Promise<VerifyResult> {
    return {
      ok: true,
      provider: "loops",
      message: "key not validated (no verify endpoint)",
    };
  }
}
