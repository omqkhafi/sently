/**
 * @module
 * Msegat SMS gateway transport (Saudi Arabia).
 *
 * Shapes follow the official Postman collection
 * ([MSEGAT Communication Platform API](https://documenter.getpostman.com/view/39158411/2sBY4LT3EY)):
 * - `POST /gw/sendsms.php` — JSON send (`code` `"1"` / `"M0000"`)
 * - `GET /gw/Credits.php` — balance / credential check
 * - `POST /gw/sendOTPCode.php` / `verifyOTPCode.php` — vendor OTP helpers
 *
 * Sently-first: wire into {@link createSmsSender}; OTP stays on this class.
 *
 * @example
 * ```ts
 * import { createSmsSender } from "sently/sms";
 * import { MsegatTransport } from "sently/transports/msegat";
 *
 * const msegat = new MsegatTransport({
 *   userName: process.env.MSEGAT_USERNAME!,
 *   apiKey: process.env.MSEGAT_API_KEY!,
 *   sender: "MyBrand",
 * });
 * const sms = createSmsSender({ transport: msegat });
 *
 * await sms.send({ to: "+9665xxxxxxxx", body: "Hello" });
 * const otp = await msegat.sendOtp({ to: "+9665xxxxxxxx", lang: "En" });
 * await msegat.verifyOtp({ id: otp.id, code: "1234", lang: "En" });
 * ```
 */

import { httpStatusToSentlyCode, SentlyError, type SentlyErrorCode } from "../core/errors.js";
import { providerFetch } from "../core/http.js";
import type { SmsOptions, SmsSendResult, SmsTransport } from "../core/sms-types.js";
import type { VerifyResult } from "../core/types.js";

/** Msegat SMS API configuration. */
export interface MsegatConfig {
  /** Msegat account username. */
  userName: string;
  /** Msegat API key. */
  apiKey: string;
  /** Pre-approved sender name (use `auth-mseg` for free OTP tests). */
  sender: string;
}

/** Options for {@link MsegatTransport.sendOtp}. */
export interface MsegatSendOtpOptions {
  /** Recipient phone number (E.164 or international digits). */
  to: string;
  /** Sender ID override; defaults to transport `sender`. */
  from?: string;
  /**
   * Message language for header + body (`Ar` or `En`).
   * Postman: "lang : Ar or En in header". Defaults to `"En"`.
   */
  lang?: "Ar" | "En";
}

/** Result of a successful {@link MsegatTransport.sendOtp} call. */
export interface MsegatOtpSendResult {
  /** OTP session id required by {@link MsegatTransport.verifyOtp}. */
  id: string;
  /** Recipient phone number as passed in. */
  to: string;
  /** Delivery status (`"accepted"` on success). */
  status: string;
  /** Raw response body text. */
  response: string;
  /** Provider identifier. */
  provider: "msegat";
}

/** Options for {@link MsegatTransport.verifyOtp}. */
export interface MsegatVerifyOtpOptions {
  /** OTP session id from {@link MsegatOtpSendResult.id}. */
  id: string | number;
  /** Code the user entered. */
  code: string;
  /** Sender ID override; defaults to transport `sender`. */
  from?: string;
  /** Message language (`Ar` or `En`). Defaults to `"En"`. */
  lang?: "Ar" | "En";
}

/** Result of a successful {@link MsegatTransport.verifyOtp} call. */
export interface MsegatOtpVerifyResult {
  /** Always `true` when the call resolves (failures throw). */
  ok: true;
  /** Provider message when present. */
  message: string;
  /** Raw response body text. */
  response: string;
  /** Provider identifier. */
  provider: "msegat";
}

/** Error thrown when the Msegat SMS API reports a failure. */
export class MsegatError extends SentlyError {
  /** Creates a Msegat SMS API error with status code and response payload. */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly apiError: unknown,
    sentlyCode?: SentlyErrorCode,
    /** Msegat response `code` when present (e.g. `"1020"`, `"M0002"`). */
    providerCode?: string,
  ) {
    super(
      message,
      sentlyCode ?? (statusCode >= 400 ? httpStatusToSentlyCode(statusCode) : "PROVIDER_ERROR"),
      {
        statusCode,
        provider: "msegat",
        cause: apiError,
      },
    );
    this.name = "MsegatError";
    if (providerCode !== undefined) {
      this.code = providerCode;
    }
  }
}

/**
 * International format without `+` or leading `00`
 * (Postman: "international format without zeros").
 */
function normalizeMsegatPhone(phone: string): string {
  let normalized = phone.trim();
  if (normalized.startsWith("+")) {
    normalized = normalized.slice(1);
  }
  if (normalized.startsWith("00")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function responseCode(payload: Record<string, unknown>): string | undefined {
  const raw = payload.code ?? payload.Code;
  if (typeof raw === "string" || typeof raw === "number") {
    return String(raw);
  }
  return undefined;
}

/** Documented success codes: `1` / `M0000` (and OTP `success: true`). */
function isSuccessCode(code: string | undefined): boolean {
  return code === "1" || code === "M0000";
}

function isSuccessPayload(payload: Record<string, unknown>): boolean {
  const code = responseCode(payload);
  if (isSuccessCode(code)) return true;
  // sendOTPCode success example includes `"success": true` alongside `code: "1"`.
  return payload.success === true && (code === undefined || isSuccessCode(code));
}

function responseMessage(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.Message === "string") return payload.Message;
  return undefined;
}

/** Map documented Msegat codes onto stable sently codes. */
function msegatCodeToSently(code: string | undefined): SentlyErrorCode {
  switch (code) {
    case "1060":
      // Balance is not enough — provider-side account state.
      return "PROVIDER_ERROR";
    case "400":
    case "404":
      // OTP expired / not found.
      return "BAD_REQUEST";
    default:
      return "BAD_REQUEST";
  }
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ response: Response; text: string; payload: Record<string, unknown> }> {
  const response = await providerFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new MsegatError("Msegat returned non-JSON response", response.status, text);
  }

  return { response, text, payload };
}

function assertSuccess(
  response: Response,
  payload: Record<string, unknown>,
  fallbackMessage: string,
): string {
  const code = responseCode(payload);
  if (!response.ok || !isSuccessPayload(payload)) {
    const message = responseMessage(payload) ?? `${fallbackMessage} (code ${code ?? "unknown"})`;
    const sentlyCode =
      response.status >= 400 ? httpStatusToSentlyCode(response.status) : msegatCodeToSently(code);
    throw new MsegatError(message, response.status, payload, sentlyCode, code);
  }
  return code ?? "1";
}

/**
 * Msegat SMS transport via JSON `sendsms.php` + Credits-based `verify()`,
 * with provider-specific OTP helpers.
 */
export class MsegatTransport implements SmsTransport {
  readonly provider = "msegat";

  private readonly userName: string;
  private readonly apiKey: string;
  private readonly sender: string;

  /** Creates an Msegat SMS transport. */
  constructor(config: MsegatConfig) {
    this.userName = config.userName;
    this.apiKey = config.apiKey;
    this.sender = config.sender;
  }

  /**
   * Sends an SMS via `POST /gw/sendsms.php`
   * (JSON: `userName`, `apiKey`, `numbers`, `userSender`, `msg`).
   */
  async send(options: SmsOptions): Promise<SmsSendResult> {
    const numbers = normalizeMsegatPhone(options.to);
    const { response, text, payload } = await postJson("https://www.msegat.com/gw/sendsms.php", {
      userName: this.userName,
      apiKey: this.apiKey,
      numbers,
      userSender: options.from ?? this.sender,
      msg: options.body,
      // Optional per Postman; UTF8 is the documented default.
      msgEncoding: "UTF8",
      // Optional: request bulk id when the account returns one.
      reqBulkId: "true",
    });

    assertSuccess(response, payload, "Msegat SMS API error");

    const idCandidate = payload.bulk_id ?? payload.messageId ?? payload.id ?? payload.Id;
    const messageId =
      typeof idCandidate === "string" || typeof idCandidate === "number"
        ? String(idCandidate)
        : (options.messageId ?? crypto.randomUUID());

    return {
      messageId,
      to: options.to,
      status: "accepted",
      response: text,
      provider: "msegat",
    };
  }

  /**
   * Vendor extra: send a provider-generated OTP via `sendOTPCode.php`.
   * Not part of {@link SmsTransport} — call on {@link MsegatTransport} directly.
   * Keep the returned {@link MsegatOtpSendResult.id} for {@link verifyOtp}.
   */
  async sendOtp(options: MsegatSendOtpOptions): Promise<MsegatOtpSendResult> {
    const lang = options.lang ?? "En";
    const number = normalizeMsegatPhone(options.to);
    const { response, text, payload } = await postJson(
      "https://www.msegat.com/gw/sendOTPCode.php",
      {
        userName: this.userName,
        apiKey: this.apiKey,
        number,
        userSender: options.from ?? this.sender,
        lang,
      },
      // Postman: "lang : Ar or En in header"
      { lang },
    );

    assertSuccess(response, payload, "Msegat OTP send error");

    const idRaw = payload.id ?? payload.Id;
    if (typeof idRaw !== "string" && typeof idRaw !== "number") {
      throw new MsegatError(
        "Msegat OTP send succeeded but returned no id",
        response.status,
        payload,
      );
    }

    return {
      id: String(idRaw),
      to: options.to,
      status: "accepted",
      response: text,
      provider: "msegat",
    };
  }

  /**
   * Vendor extra: verify a code previously sent with {@link sendOtp} via
   * `verifyOTPCode.php`. Not part of {@link SmsTransport} — call on
   * {@link MsegatTransport} directly. Throws {@link MsegatError} when the code
   * is invalid, expired (`400`), or not found (`404`).
   */
  async verifyOtp(options: MsegatVerifyOtpOptions): Promise<MsegatOtpVerifyResult> {
    const lang = options.lang ?? "En";
    const { response, text, payload } = await postJson(
      "https://www.msegat.com/gw/verifyOTPCode.php",
      {
        userName: this.userName,
        apiKey: this.apiKey,
        code: options.code,
        id: options.id,
        userSender: options.from ?? this.sender,
        lang,
      },
      { lang },
    );

    assertSuccess(response, payload, "Msegat OTP verify error");

    return {
      ok: true,
      message: responseMessage(payload) ?? "Success",
      response: text,
      provider: "msegat",
    };
  }

  /**
   * Credential check via `GET /gw/Credits.php` (no SMS sent).
   * Postman success body is a bare balance number (e.g. `"272.6"`).
   */
  async verify(): Promise<VerifyResult> {
    if (!this.userName || !this.apiKey || !this.sender) {
      return { ok: false, provider: "msegat", message: "Missing credentials" };
    }

    const url = new URL("https://www.msegat.com/gw/Credits.php");
    url.searchParams.set("userName", this.userName);
    url.searchParams.set("apiKey", this.apiKey);

    try {
      const response = await providerFetch(url, {
        method: "GET",
        headers: {
          // Matches Postman Credits request headers.
          "Content-Type": "application/json",
        },
      });
      const text = (await response.text()).trim();

      if (!response.ok) {
        return {
          ok: false,
          provider: "msegat",
          message: `Credits inquiry failed (HTTP ${response.status}): ${text || "empty body"}`,
        };
      }

      const balance = Number(text);
      if (Number.isFinite(balance)) {
        return {
          ok: true,
          provider: "msegat",
          message: `Balance: ${text}`,
        };
      }

      // Some failures still return HTTP 200 with a code/message JSON body.
      try {
        const payload = JSON.parse(text) as Record<string, unknown>;
        if (isSuccessPayload(payload)) {
          return { ok: true, provider: "msegat", message: responseMessage(payload) ?? "OK" };
        }
        const code = responseCode(payload);
        return {
          ok: false,
          provider: "msegat",
          message: responseMessage(payload) ?? `Credits inquiry failed (code ${code ?? "unknown"})`,
        };
      } catch {
        return {
          ok: false,
          provider: "msegat",
          message: `Credits inquiry returned unexpected body: ${text}`,
        };
      }
    } catch (error) {
      return {
        ok: false,
        provider: "msegat",
        message: error instanceof Error ? error.message : "Credits inquiry failed",
      };
    }
  }
}
