/**
 * @module
 * Twilio Messages API transport for SMS.
 *
 * Aligned with Twilio Programmable Messaging
 * ([Message resource](https://www.twilio.com/docs/messaging/api/message-resource)):
 * `POST /2010-04-01/Accounts/{AccountSid}/Messages.json` with
 * `application/x-www-form-urlencoded` and HTTP Basic auth.
 *
 * Sender must be {@link TwilioSmsConfig.from} / `options.from` **or**
 * {@link TwilioSmsConfig.messagingServiceSid} (Twilio selects from the Sender Pool
 * when `From` is omitted).
 *
 * Sently-first: wire into {@link createSmsSender}. Twilio-only products (Verify,
 * Voice, Conversations, etc.) stay off this transport unless added as concrete
 * helpers later.
 *
 * Production auth: set `apiKey` + `authToken` (API Key Secret) with `accountSid`
 * still required in the URL path. Account SID + Auth Token alone is fine for
 * local testing — never hardcode credentials in source.
 *
 * @example
 * ```ts
 * import { createSmsSender } from "sently/sms";
 * import { TwilioSmsTransport } from "sently/transports/twilio-sms";
 *
 * const sms = createSmsSender({
 *   transport: new TwilioSmsTransport({
 *     accountSid: process.env.TWILIO_ACCOUNT_SID!,
 *     apiKey: process.env.TWILIO_API_KEY!,
 *     authToken: process.env.TWILIO_API_KEY_SECRET!,
 *     from: "+15557654321",
 *   }),
 * });
 * ```
 */

import { encodeBase64 } from "../core/base64.js";
import { httpStatusToSentlyCode, SentlyError } from "../core/errors.js";
import { providerFetch } from "../core/http.js";
import type { SmsOptions, SmsSendResult, SmsTransport } from "../core/sms-types.js";
import type { VerifyResult } from "../core/types.js";

/** Twilio Messages API configuration. */
export interface TwilioSmsConfig {
  /**
   * Twilio Account SID — always used in the Messages API URL path.
   * Store in environment variables — never hardcode.
   */
  accountSid: string;
  /**
   * Basic-auth password: API Key Secret when {@link apiKey} is set, otherwise Auth Token.
   * Store in environment variables — never hardcode.
   */
  authToken: string;
  /**
   * Optional Twilio API Key SID used as Basic-auth username (recommended in production).
   * When omitted, {@link accountSid} is used as the Basic-auth username.
   */
  apiKey?: string;
  /**
   * Default From phone number, alphanumeric sender ID, short code, or channel address
   * (E.164 recommended, e.g. `+15557654321`). Either this / `options.from` or
   * {@link messagingServiceSid} is required.
   */
  from?: string;
  /**
   * Messaging Service SID (`MG…`). When set and `From` is omitted, Twilio selects
   * the optimal sender from the service's Sender Pool.
   */
  messagingServiceSid?: string;
  /**
   * Optional status callback URL (`StatusCallback`). Twilio POSTs delivery updates here.
   */
  statusCallback?: string;
}

/** Error thrown when the Twilio SMS API returns a non-success response. */
export class TwilioSmsError extends SentlyError {
  /** Creates a Twilio SMS API error with status code and response payload. */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly apiError: unknown,
  ) {
    super(message, httpStatusToSentlyCode(statusCode), {
      statusCode,
      provider: "twilio-sms",
      cause: apiError,
    });
    this.name = "TwilioSmsError";
  }
}

/**
 * Twilio SMS transport via the Messages REST API (form-urlencoded).
 */
export class TwilioSmsTransport implements SmsTransport {
  readonly provider = "twilio-sms";

  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly apiKey?: string;
  private readonly from?: string;
  private readonly messagingServiceSid?: string;
  private readonly statusCallback?: string;

  /** Creates a Twilio SMS transport. */
  constructor(config: TwilioSmsConfig) {
    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    if (config.apiKey !== undefined) {
      this.apiKey = config.apiKey;
    }
    if (config.from !== undefined) {
      this.from = config.from;
    }
    if (config.messagingServiceSid !== undefined) {
      this.messagingServiceSid = config.messagingServiceSid;
    }
    if (config.statusCallback !== undefined) {
      this.statusCallback = config.statusCallback;
    }
  }

  /** Sends an SMS via Twilio Messages API. */
  async send(options: SmsOptions): Promise<SmsSendResult> {
    const from = options.from ?? this.from;
    if (!from && !this.messagingServiceSid) {
      throw new TwilioSmsError("Twilio SMS requires From or MessagingServiceSid", 400, {
        message: "Missing from / messagingServiceSid",
      });
    }

    // Keep E.164 `+` — Twilio expects it (unlike Taqnyat/Msegat).
    const body = new URLSearchParams({
      To: options.to,
      Body: options.body,
    });
    if (from) {
      body.set("From", from);
    }
    if (this.messagingServiceSid) {
      body.set("MessagingServiceSid", this.messagingServiceSid);
    }
    if (this.statusCallback) {
      body.set("StatusCallback", this.statusCallback);
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const response = await providerFetch(url, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });

    const payload = await this.readJson(response);

    if (!response.ok) {
      const message =
        typeof payload === "object" &&
        payload !== null &&
        "message" in payload &&
        typeof (payload as { message: unknown }).message === "string"
          ? (payload as { message: string }).message
          : "Twilio SMS API error";
      throw new TwilioSmsError(message, response.status, payload);
    }

    const record = payload as {
      sid?: string;
      status?: string;
    };

    return {
      messageId: record.sid ?? options.messageId ?? "",
      to: options.to,
      status: record.status ?? "queued",
      response: record.status ?? "queued",
      provider: "twilio-sms",
    };
  }

  /**
   * Validates credentials via Twilio Account fetch
   * (`GET /2010-04-01/Accounts/{AccountSid}.json`).
   */
  async verify(): Promise<VerifyResult> {
    if (!this.accountSid || !this.authToken) {
      return { ok: false, provider: "twilio-sms", message: "Missing credentials" };
    }

    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}.json`;
      const response = await providerFetch(url, {
        method: "GET",
        headers: {
          ...this.authHeaders(),
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const payload = await this.readJson(response);
        const message =
          typeof payload === "object" &&
          payload !== null &&
          "message" in payload &&
          typeof (payload as { message: unknown }).message === "string"
            ? (payload as { message: string }).message
            : `HTTP ${response.status}`;
        return { ok: false, provider: "twilio-sms", message };
      }

      const payload = (await this.readJson(response)) as {
        friendly_name?: string;
        status?: string;
      };
      const label = payload.friendly_name ?? payload.status ?? "ok";
      return { ok: true, provider: "twilio-sms", message: `Account ${label}` };
    } catch (error) {
      return {
        ok: false,
        provider: "twilio-sms",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private authHeaders(): { Authorization: string } {
    const authUser = this.apiKey ?? this.accountSid;
    const credentials = encodeBase64(`${authUser}:${this.authToken}`).replace(/\r\n/g, "");
    return { Authorization: `Basic ${credentials}` };
  }

  private async readJson(response: Response): Promise<unknown> {
    return response.json().catch(() => ({}));
  }
}
