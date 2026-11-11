import { describe, expect, test } from "bun:test";
import { SentlyError, httpStatusToSentlyCode, smtpCodeToSentlyCode } from "../../src/core/errors.js";
import { SMTPError } from "../../src/core/smtp.js";
import { BrevoError } from "../../src/transports/brevo.js";
import { ResendError } from "../../src/transports/resend.js";
import { SendGridError } from "../../src/transports/sendgrid.js";
import { SESError } from "../../src/transports/ses.js";

describe("SentlyError hierarchy", () => {
  test("httpStatusToSentlyCode maps status codes", () => {
    expect(httpStatusToSentlyCode(429)).toBe("RATE_LIMITED");
    expect(httpStatusToSentlyCode(500)).toBe("PROVIDER_ERROR");
    expect(httpStatusToSentlyCode(503)).toBe("PROVIDER_ERROR");
    expect(httpStatusToSentlyCode(400)).toBe("BAD_REQUEST");
    expect(httpStatusToSentlyCode(401)).toBe("BAD_REQUEST");
  });

  test("smtpCodeToSentlyCode maps SMTP codes", () => {
    expect(smtpCodeToSentlyCode(535, "AUTH LOGIN")).toBe("SMTP_AUTH_FAILED");
    expect(smtpCodeToSentlyCode(550, "RCPT TO")).toBe("PROVIDER_ERROR");
    expect(smtpCodeToSentlyCode(554, "DATA")).toBe("PROVIDER_ERROR");
    expect(smtpCodeToSentlyCode(0, "CONNECT")).toBe("CONNECTION_FAILED");
    expect(smtpCodeToSentlyCode(450, "MAIL FROM")).toBe("TRANSIENT");
    expect(smtpCodeToSentlyCode(421, "MAIL FROM")).toBe("TRANSIENT");
  });

  test("ResendError instanceof ResendError and SentlyError with mapped code", () => {
    const err = new ResendError("Unauthorized", 401, { message: "Unauthorized" });

    expect(err).toBeInstanceOf(ResendError);
    expect(err).toBeInstanceOf(SentlyError);
    expect(err.name).toBe("ResendError");
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.sentlyCode).toBe("BAD_REQUEST");
    expect(err.provider).toBe("resend");
    expect(err.apiError).toEqual({ message: "Unauthorized" });
  });

  test("ResendError maps 429 to RATE_LIMITED", () => {
    const err = new ResendError("Too many requests", 429, {});

    expect(err.code).toBe("RATE_LIMITED");
    expect(err.sentlyCode).toBe("RATE_LIMITED");
  });

  test("SendGridError maps 503 to PROVIDER_ERROR", () => {
    const err = new SendGridError("Unavailable", 503, "body");

    expect(err).toBeInstanceOf(SentlyError);
    expect(err.code).toBe("PROVIDER_ERROR");
    expect(err.statusCode).toBe(503);
    expect(err.apiError).toBe("body");
  });

  test("SMTPError preserves numeric code and command properties", () => {
    const err = new SMTPError("Auth failed", 535, "AUTH LOGIN", "Authentication failed");

    expect(err).toBeInstanceOf(SMTPError);
    expect(err).toBeInstanceOf(SentlyError);
    expect(err.name).toBe("SMTPError");
    expect(err.code).toBe(535);
    expect(err.sentlyCode).toBe("SMTP_AUTH_FAILED");
    expect(err.command).toBe("AUTH LOGIN");
    expect(err.response).toBe("Authentication failed");
    expect(err.provider).toBe("smtp");
  });

  test("BrevoError preserves provider code and sentlyCode from HTTP status", () => {
    const err = new BrevoError("Invalid API key", 401, "invalid_key");

    expect(err).toBeInstanceOf(BrevoError);
    expect(err).toBeInstanceOf(SentlyError);
    expect(err.code).toBe("invalid_key");
    expect(err.sentlyCode).toBe("BAD_REQUEST");
    expect(err.statusCode).toBe(401);
  });

  test("SESError preserves AWS code and sentlyCode from HTTP status", () => {
    const err = new SESError("Message rejected", 400, "MessageRejected", "req-123");

    expect(err).toBeInstanceOf(SESError);
    expect(err).toBeInstanceOf(SentlyError);
    expect(err.code).toBe("MessageRejected");
    expect(err.sentlyCode).toBe("BAD_REQUEST");
    expect(err.requestId).toBe("req-123");
  });
});
