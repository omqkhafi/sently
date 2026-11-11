/**
 * @module
 * Unified error hierarchy for sently transports and SMTP.
 */

/** Stable machine-readable error codes shared across providers. */
export type SentlyErrorCode =
  | "INVALID_CONFIG"
  | "SMTP_AUTH_FAILED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "CONNECTION_FAILED"
  | "TLS_FAILED"
  | "TRANSIENT"
  | "PROVIDER_ERROR"
  | "BAD_REQUEST";

/** Options for constructing a {@link SentlyError}. */
export interface SentlyErrorOptions {
  /** HTTP status code when the failure originated from an HTTP transport. */
  statusCode?: number;
  /** Original error or response payload. */
  cause?: unknown;
  /** Provider identifier (e.g. `"smtp"`, `"resend"`). */
  provider?: string;
  /**
   * Whether the failure is permanent.
   * `false` for SMTP 4xx / {@link SentlyErrorCode} `"TRANSIENT"`.
   * `true` for SMTP 5xx. Omitted when permanence is unknown.
   */
  permanent?: boolean;
}

/**
 * Base error class for all sently transport and protocol failures.
 *
 * Subclasses may shadow {@link code} with provider-specific or numeric values
 * (e.g. SMTP response codes). Use {@link sentlyCode} for the stable machine-readable
 * code in those cases.
 */
export class SentlyError extends Error {
  /**
   * Stable machine-readable error code.
   * Preserved even when a subclass shadows {@link code}.
   */
  readonly sentlyCode: SentlyErrorCode;

  /** HTTP status code when applicable. */
  readonly statusCode?: number;

  /** Provider identifier when applicable. */
  readonly provider?: string;

  /**
   * Whether the failure is permanent.
   * Safe to log. SMTP 4xx is `false`; SMTP 5xx is `true`.
   */
  readonly permanent?: boolean;

  /**
   * Error code — machine-readable string on {@link SentlyError}, or a legacy
   * provider/SMTP-specific value on subclasses (numeric SMTP codes, Brevo/SES API codes).
   */
  code: string | number;

  /** Creates a sently error with a machine-readable code and optional metadata. */
  constructor(message: string, sentlyCode: SentlyErrorCode, options?: SentlyErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SentlyError";
    this.sentlyCode = sentlyCode;
    this.code = sentlyCode;
    if (options?.statusCode !== undefined) {
      this.statusCode = options.statusCode;
    }
    if (options?.provider !== undefined) {
      this.provider = options.provider;
    }
    if (options?.permanent !== undefined) {
      this.permanent = options.permanent;
    }
  }

  /**
   * Fields that are safe to log or serialize.
   * Subclasses omit provider response text that may contain recipients or usernames.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      sentlyCode: this.sentlyCode,
      code: this.code,
      ...(this.statusCode !== undefined ? { statusCode: this.statusCode } : {}),
      ...(this.provider !== undefined ? { provider: this.provider } : {}),
      ...(this.permanent !== undefined ? { permanent: this.permanent } : {}),
    };
  }
}

/**
 * Map an HTTP status code to a stable sently error code.
 *
 * @param status - HTTP response status code
 * @returns Machine-readable error code
 */
export function httpStatusToSentlyCode(status: number): SentlyErrorCode {
  if (status === 429) {
    return "RATE_LIMITED";
  }
  if (status >= 500) {
    return "PROVIDER_ERROR";
  }
  if (status >= 400) {
    return "BAD_REQUEST";
  }
  return "PROVIDER_ERROR";
}

/**
 * Map an SMTP response code and command to a stable sently error code.
 *
 * @param smtpCode - Three-digit SMTP response code (0 for local/parse errors)
 * @param command - SMTP command that failed
 * @returns Machine-readable error code
 */
export function smtpCodeToSentlyCode(smtpCode: number, command: string): SentlyErrorCode {
  if (smtpCode === 535 || smtpCode === 534) {
    return "SMTP_AUTH_FAILED";
  }
  if (smtpCode === 421 || smtpCode === 450 || smtpCode === 451) {
    return "TRANSIENT";
  }
  if (smtpCode === 0) {
    if (command === "CONNECT" || command === "READ" || command === "MX") {
      return "CONNECTION_FAILED";
    }
    return "PROVIDER_ERROR";
  }
  if (smtpCode >= 500) {
    return "PROVIDER_ERROR";
  }
  if (smtpCode >= 400) {
    return "BAD_REQUEST";
  }
  return "PROVIDER_ERROR";
}
