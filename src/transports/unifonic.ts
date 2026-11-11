/**
 * @module
 * Unifonic SMS REST transport (el.cloud).
 *
 * Aligned with Unifonic Send Message
 * (`POST https://el.cloud.unifonic.com/rest/SMS/messages`):
 * JSON body with `AppSid`, `SenderID`, `Recipient`, `Body`.
 *
 * Sently-first: wire into {@link createSmsSender}.
 *
 * @example
 * ```ts
 * import { createSmsSender } from "sently/sms";
 * import { UnifonicTransport } from "sently/transports/unifonic";
 *
 * const sms = createSmsSender({
 *   transport: new UnifonicTransport({
 *     appSid: process.env.UNIFONIC_APPSID!,
 *     senderId: "MyBrand",
 *   }),
 * });
 *
 * await sms.send({ to: "+9665xxxxxxxx", body: "Hello" });
 * ```
 */

import { httpStatusToSentlyCode, SentlyError } from "../core/errors.js";
import { providerFetch } from "../core/http.js";
import type { SmsOptions, SmsSendResult, SmsTransport } from "../core/sms-types.js";
import type { VerifyResult } from "../core/types.js";

const UNIFONIC_SEND_URL = "https://el.cloud.unifonic.com/rest/SMS/messages";

/** Unifonic SMS API configuration. */
export interface UnifonicConfig {
  /**
   * Application SID (`AppSid`) from the Unifonic dashboard.
   * Store in environment variables — never hardcode.
   */
  appSid: string;
  /**
   * Default SenderID (brand / approved sender). Required unless every send
   * passes `options.from` (mapped to `SenderID`).
   */
  senderId?: string;
  /**
   * Optional delivery status callback URL forwarded as `statusCallback`.
   * Unifonic requires a public HTTPS URL (el.cloud OpenAPI).
   */
  statusCallback?: string;
  /**
   * When true, request async execution (`async: true`). Default: false.
   */
  async?: boolean;
}

/** Error thrown when the Unifonic SMS API returns a non-success response. */
export class UnifonicError extends SentlyError {
  /** Creates a Unifonic SMS API error with status code and response payload. */
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
        provider: "unifonic",
        cause: apiError,
      },
    );
    this.name = "UnifonicError";
  }
}

/**
 * Normalize a phone number for Unifonic: international digits without `+` or
 * leading `00`.
 */
export function normalizeUnifonicPhone(to: string): string {
  const trimmed = to.trim();
  if (trimmed.startsWith("+")) {
    return trimmed.slice(1).replace(/\D/g, "");
  }
  if (trimmed.startsWith("00")) {
    return trimmed.slice(2).replace(/\D/g, "");
  }
  return trimmed.replace(/\D/g, "");
}

/** Unifonic OpenAPI: statusCallback must be a public HTTPS URL. */
function assertHttpsStatusCallback(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnifonicError("Unifonic statusCallback must be a valid HTTPS URL", 400, {
      field: "statusCallback",
      value: url,
    });
  }
  if (parsed.protocol !== "https:") {
    throw new UnifonicError("Unifonic statusCallback must use https:", 400, {
      field: "statusCallback",
      protocol: parsed.protocol,
    });
  }
  if (parsed.username || parsed.password) {
    throw new UnifonicError("Unifonic statusCallback must not include credentials", 400, {
      field: "statusCallback",
    });
  }
}

/**
 * Unifonic SMS transport via el.cloud REST (`AppSid` + JSON).
 */
export class UnifonicTransport implements SmsTransport {
  readonly provider = "unifonic";

  private readonly appSid: string;
  private readonly senderId: string | undefined;
  private readonly statusCallback: string | undefined;
  private readonly async: boolean;

  /** Creates an Unifonic SMS transport. */
  constructor(config: UnifonicConfig) {
    this.appSid = config.appSid;
    this.senderId = config.senderId;
    if (config.statusCallback !== undefined) {
      assertHttpsStatusCallback(config.statusCallback);
      this.statusCallback = config.statusCallback;
    } else {
      this.statusCallback = undefined;
    }
    this.async = config.async ?? false;
  }

  /**
   * Sends an SMS via `POST https://el.cloud.unifonic.com/rest/SMS/messages`
   * (JSON: `AppSid`, `SenderID`, `Recipient`, `Body`; optional `CorrelationID`).
   */
  async send(options: SmsOptions): Promise<SmsSendResult> {
    const senderId = options.from ?? this.senderId;
    if (senderId === undefined || senderId.length === 0) {
      throw new UnifonicError(
        "Unifonic requires SenderID via config.senderId or options.from",
        400,
        { field: "SenderID" },
      );
    }

    const body: Record<string, unknown> = {
      AppSid: this.appSid,
      SenderID: senderId,
      Recipient: normalizeUnifonicPhone(options.to),
      Body: options.body,
      responseType: "JSON",
      async: this.async,
    };

    if (options.messageId !== undefined) {
      body.CorrelationID = options.messageId;
    }
    if (this.statusCallback !== undefined) {
      body.statusCallback = this.statusCallback;
    }

    const response = await providerFetch(UNIFONIC_SEND_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    let payload: {
      /** OpenAPI examples use both boolean `true` and string `"true"`. */
      success?: boolean | string;
      message?: string;
      errorCode?: string;
      data?: {
        MessageID?: number | string;
        CorrelationID?: string;
        Status?: string;
        Cost?: number;
        Balance?: number;
        Recipient?: string;
        CurrencyCode?: string;
      };
    };
    try {
      payload = text.length > 0 ? (JSON.parse(text) as typeof payload) : {};
    } catch {
      throw new UnifonicError("Unifonic returned non-JSON response", response.status, text);
    }

    // OpenAPI examples use both boolean `true` and string `"true"` for success.
    const successFlag = payload.success === true || payload.success === "true";
    const successCode = payload.errorCode === "ER-00" || payload.errorCode === "ER00";
    const success = response.ok && (successFlag || successCode);

    if (!success) {
      throw new UnifonicError(
        payload.message || `Unifonic SMS API error (${payload.errorCode ?? response.status})`,
        response.status >= 400 ? response.status : 400,
        payload,
      );
    }

    const data = payload.data ?? {};
    const status = typeof data.Status === "string" ? data.Status : "accepted";

    return {
      messageId: String(data.MessageID ?? options.messageId ?? data.CorrelationID ?? ""),
      to: options.to,
      status: status.toLowerCase() === "sent" ? "accepted" : status,
      response:
        data.Cost !== undefined
          ? `cost: ${data.Cost} ${data.CurrencyCode ?? ""}`.trim()
          : (payload.message ?? status),
      provider: "unifonic",
    };
  }

  /** Lightweight credential check. */
  async verify(): Promise<VerifyResult> {
    const ok = Boolean(this.appSid);
    return {
      ok,
      provider: "unifonic",
      message: ok ? "Credentials present" : "Missing appSid",
    };
  }
}
