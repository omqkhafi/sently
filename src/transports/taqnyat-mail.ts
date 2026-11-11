/**
 * @module
 * Taqnyat Email API transport (`mailSend.php`).
 *
 * Follows [Taqnyat Email](https://dev.taqnyat.sa/ar/doc/mail/):
 * `POST https://api.taqnyat.sa/mailSend.php` with `bearerTokens`, `campaignName`,
 * `subject`, `from`, `to`, `msg`. Success: HTTP 201 + `ResponseStatus: "success"`
 * and `Data.msgId`.
 *
 * Sently-first: wire into {@link createMailer}.
 *
 * @example
 * ```ts
 * import { createMailer } from "sently/mailer";
 * import { TaqnyatMailTransport } from "sently/transports/taqnyat-mail";
 *
 * const mailer = await createMailer({
 *   transport: new TaqnyatMailTransport({
 *     bearerToken: process.env.TAQNYAT_MAIL_TOKEN!,
 *     campaignName: "transactional",
 *   }),
 * });
 * ```
 */

import { extractEmails, parseAddresses } from "../core/address.js";
import { httpStatusToSentlyCode, SentlyError } from "../core/errors.js";
import { providerFetch, readJsonBody } from "../core/http.js";
import type { MailOptions, SendResult, Transport, VerifyResult } from "../core/types.js";

/** Taqnyat Email API configuration. */
export interface TaqnyatMailConfig {
  /** Bearer token from a Taqnyat application enabled for Email (`bearerTokens`). */
  bearerToken: string;
  /**
   * Campaign name required by `mailSend.php`.
   * Must be consistent across channels when using Taqnyat failover features.
   */
  campaignName: string;
}

/** Error thrown when the Taqnyat Email API reports a failure. */
export class TaqnyatMailError extends SentlyError {
  /** Creates a Taqnyat Email API error with status code and response payload. */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly apiError: unknown,
  ) {
    super(
      message,
      httpStatusToSentlyCode(statusCode >= 100 && statusCode < 600 ? statusCode : 400),
      {
        statusCode,
        provider: "taqnyat-mail",
        cause: apiError,
      },
    );
    this.name = "TaqnyatMailError";
  }
}

/**
 * Taqnyat Email transport via `mailSend.php`.
 */
export class TaqnyatMailTransport implements Transport {
  readonly provider = "taqnyat-mail";

  private readonly bearerToken: string;
  private readonly campaignName: string;

  /** Creates a Taqnyat Email transport. */
  constructor(config: TaqnyatMailConfig) {
    this.bearerToken = config.bearerToken;
    this.campaignName = config.campaignName;
  }

  /** Sends an email via Taqnyat `mailSend.php`. */
  async send(options: MailOptions): Promise<SendResult> {
    const from = parseAddresses(options.from)[0];
    const msg = options.html ?? options.text;
    if (!msg) {
      throw new TaqnyatMailError("Taqnyat mail requires html or text body", 400, {
        message: "Missing body",
      });
    }
    if (!from?.address) {
      throw new TaqnyatMailError("Taqnyat mail requires a from address", 400, {
        message: "Missing from",
      });
    }

    const toList = extractEmails(options.to);
    // Docs examples: plain email addresses + comma-separated `to`, `bearerTokens` param.
    const params = new URLSearchParams({
      bearerTokens: this.bearerToken,
      campaignName: this.campaignName,
      subject: options.subject,
      from: from.address,
      to: toList.join(","),
      msg,
    });

    const response = await providerFetch("https://api.taqnyat.sa/mailSend.php", {
      method: "POST",
      headers: {
        // Auth section: Bearer for REST; examples also pass bearerTokens in the body.
        Authorization: `Bearer ${this.bearerToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });

    const payload = (await readJsonBody(response, "taqnyat-mail")) as {
      status?: number;
      ResponseStatus?: string;
      Data?: {
        msgId?: number | string;
        MessageEn?: string;
        MessageAr?: string;
        price?: string;
      } | null;
      Error?: {
        ErrorCode?: number;
        MessageEn?: string;
        MessageAr?: string;
      } | null;
    };

    const succeeded =
      payload.ResponseStatus === "success" && payload.Data != null && payload.Error == null;

    if (!succeeded) {
      const message =
        payload.Error?.MessageEn?.trim() ||
        payload.Error?.MessageAr?.trim() ||
        "Taqnyat Email API error";
      throw new TaqnyatMailError(
        message,
        payload.Error?.ErrorCode ?? (response.ok ? 400 : response.status),
        payload,
      );
    }

    return {
      messageId: String(payload.Data?.msgId ?? options.messageId ?? ""),
      accepted: toList,
      rejected: [],
      response: payload.Data?.MessageEn ?? "sent successfully",
      envelope: {
        from: from.address,
        to: toList,
      },
      provider: "taqnyat-mail",
    };
  }

  /** Lightweight credential check. */
  async verify(): Promise<VerifyResult> {
    return {
      ok: Boolean(this.bearerToken && this.campaignName),
      provider: "taqnyat-mail",
      message:
        this.bearerToken && this.campaignName ? "Credentials present" : "Missing credentials",
    };
  }
}
