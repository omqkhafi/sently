// src/core/smtp.ts
import { encodeBase64, encodeUtf8 } from "./base64.js";
import { SentlyError, smtpCodeToSentlyCode } from "./errors.js";

export { computeCRAMMD5 } from "./cram-md5.js";

/** SMTP command to send to the server. */
export type SMTPCommand =
  | { type: "EHLO"; domain: string }
  | { type: "STARTTLS" }
  | { type: "AUTH_LOGIN"; user: string; pass: string }
  | { type: "AUTH_PLAIN"; user: string; pass: string }
  | { type: "AUTH_CRAM_MD5_INIT" }
  | { type: "AUTH_CRAM_MD5_RESPONSE"; response: string }
  | { type: "AUTH_XOAUTH2"; xoauth2String: string }
  | { type: "MAIL_FROM"; address: string; eightBit?: boolean }
  | { type: "RCPT_TO"; address: string }
  | { type: "DATA" }
  | { type: "DATA_BODY"; content: Uint8Array }
  | { type: "QUIT" }
  | { type: "RSET" }
  | { type: "NOOP" };

/** Parsed SMTP server response. */
export interface SMTPResponse {
  /** Three-digit SMTP status code. */
  code: number;
  /** Human-readable response text after the status code. */
  message: string;
  /** True when the code is in the 2xx success range. */
  isSuccess: boolean;
  /** True when the code is 354 (ready for message data). */
  isReady: boolean;
  /** True when the code is 4xx or 5xx. */
  isError: boolean;
}

/** SMTP protocol error with server response details. */
export class SMTPError extends SentlyError {
  /** Creates an SMTP protocol error. */
  constructor(
    message: string,
    smtpCode: number,
    public readonly command: string,
    public readonly response: string,
  ) {
    const permanent = smtpCode >= 500 ? true : smtpCode >= 400 ? false : undefined;
    super(message, smtpCodeToSentlyCode(smtpCode, command), {
      provider: "smtp",
      ...(permanent !== undefined ? { permanent } : {}),
    });
    this.name = "SMTPError";
    this.code = smtpCode;
  }

  /**
   * Safe-to-log fields. Server text stays on {@link response} for callers that
   * read it explicitly, and is omitted from `JSON.stringify`.
   */
  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      sentlyCode: this.sentlyCode,
      code: this.code,
      command: this.command,
      ...(this.provider !== undefined ? { provider: this.provider } : {}),
      ...(this.permanent !== undefined ? { permanent: this.permanent } : {}),
    };
  }
}

/**
 * Encode an SMTPCommand into a Uint8Array for sending over the socket.
 */
export function encodeCommand(cmd: SMTPCommand): Uint8Array {
  let line: string;

  switch (cmd.type) {
    case "EHLO": {
      const safeDomain = cmd.domain.replace(/[\r\n]/g, "");
      line = `EHLO ${safeDomain}`;
      break;
    }
    case "STARTTLS":
      line = "STARTTLS";
      break;
    case "AUTH_LOGIN":
      line = "AUTH LOGIN";
      break;
    case "AUTH_PLAIN":
      line = `AUTH PLAIN ${encodeBase64(`\0${cmd.user}\0${cmd.pass}`).replace(/\r\n/g, "")}`;
      break;
    case "AUTH_CRAM_MD5_INIT":
      line = "AUTH CRAM-MD5";
      break;
    case "AUTH_CRAM_MD5_RESPONSE":
      return encodeUtf8(`${cmd.response}\r\n`);
    case "AUTH_XOAUTH2":
      line = `AUTH XOAUTH2 ${cmd.xoauth2String}`;
      break;
    case "MAIL_FROM":
      if (/[\r\n]/.test(cmd.address)) {
        throw new SMTPError(`Invalid address: contains CRLF`, 0, "MAIL FROM", cmd.address);
      }
      line = `MAIL FROM:<${cmd.address}>${cmd.eightBit ? " BODY=8BITMIME" : ""}`;
      break;
    case "RCPT_TO":
      if (/[\r\n]/.test(cmd.address)) {
        throw new SMTPError(`Invalid address: contains CRLF`, 0, "RCPT TO", cmd.address);
      }
      line = `RCPT TO:<${cmd.address}>`;
      break;
    case "DATA":
      line = "DATA";
      break;
    case "DATA_BODY":
      return encodeUtf8(applyDotStuffing(cmd.content));
    case "QUIT":
      line = "QUIT";
      break;
    case "RSET":
      line = "RSET";
      break;
    case "NOOP":
      line = "NOOP";
      break;
  }

  return encodeUtf8(`${line}\r\n`);
}

/**
 * Parse raw bytes from the server into an SMTPResponse.
 */
export function parseResponse(data: Uint8Array): SMTPResponse {
  const text = new TextDecoder().decode(data).trim();
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const finalIndex = lines.findIndex((line) => /^\d{3} /.test(line));
  const replyLines = finalIndex === -1 ? lines : lines.slice(0, finalIndex + 1);
  const lastLine = replyLines[replyLines.length - 1] ?? "";
  const match = lastLine.match(/^(\d{3})([\s-])(.*)$/);

  if (!match) {
    throw new SMTPError("Invalid SMTP response", 0, "PARSE", text);
  }

  const code = Number.parseInt(match[1] ?? "0", 10);
  const message = replyLines.map((l) => l.replace(/^\d{3}[\s-]/, "")).join(" ");

  return {
    code,
    message,
    isSuccess: code >= 200 && code < 300,
    isReady: code >= 300 && code < 400,
    isError: code >= 400,
  };
}

/**
 * Accumulate byte chunks until a complete SMTP response is received.
 */
export function accumulateResponse(chunks: Uint8Array[]): Uint8Array | null {
  if (chunks.length === 0) {
    return null;
  }

  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  const text = new TextDecoder().decode(combined);
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);

  if (lines.length === 0) {
    return null;
  }

  const lastLine = lines[lines.length - 1] ?? "";
  if (/^\d{3} /.test(lastLine)) {
    return combined;
  }

  return null;
}

const AUTH_MECHANISMS = ["XOAUTH2", "CRAM-MD5", "LOGIN", "PLAIN"] as const;

/**
 * Select the best AUTH method from EHLO capability lines.
 * Mechanisms may be space-separated (`AUTH LOGIN PLAIN`) or `=`-separated
 * (`AUTH=LOGIN`), including when a parser has already split them into tokens.
 * Priority: XOAUTH2 > CRAM-MD5 > LOGIN > PLAIN.
 */
export function selectAuthMethod(
  capabilities: string[],
): "LOGIN" | "PLAIN" | "CRAM-MD5" | "OAUTH2" {
  const tokens = capabilities.flatMap((capability) =>
    capability
      .toUpperCase()
      .split(/[\s=]+/)
      .filter((token) => token.length > 0),
  );
  const offered = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "AUTH") {
      continue;
    }
    for (let j = i + 1; j < tokens.length; j++) {
      const token = tokens[j] ?? "";
      if (!AUTH_MECHANISMS.includes(token as (typeof AUTH_MECHANISMS)[number])) {
        break;
      }
      offered.add(token);
    }
  }
  if (offered.has("XOAUTH2")) {
    return "OAUTH2";
  }
  if (offered.has("CRAM-MD5")) {
    return "CRAM-MD5";
  }
  if (offered.has("LOGIN")) {
    return "LOGIN";
  }
  if (offered.has("PLAIN")) {
    return "PLAIN";
  }
  throw new SMTPError("No supported AUTH method", 0, "EHLO", capabilities.join(" "));
}

/**
 * Split the first complete SMTP reply from a byte buffer.
 * Continuation lines (`250-`) stay with that reply. Bytes after the first
 * final line (`250 `) are returned as `rest` for the next read.
 *
 * @param data - Bytes received so far
 * @returns The reply and leftover bytes, or null when the reply is incomplete
 */
export function splitSmtpReply(data: Uint8Array): { reply: Uint8Array; rest: Uint8Array } | null {
  let lineStart = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0x0a) {
      continue;
    }
    const lineEnd = i > 0 && data[i - 1] === 0x0d ? i - 1 : i;
    const line = new TextDecoder().decode(data.subarray(lineStart, lineEnd));
    if (/^\d{3} /.test(line)) {
      const end = i + 1;
      return { reply: data.slice(0, end), rest: data.slice(end) };
    }
    lineStart = i + 1;
  }
  return null;
}

/**
 * Parse an EHLO multi-line response and extract capability keywords.
 */
export function parseEHLO(response: SMTPResponse): string[] {
  return response.message
    .split(/\s+/)
    .flatMap((part) => part.split(/\r?\n/))
    .filter(Boolean);
}

/**
 * Assert that an SMTPResponse code is within the expected set.
 */
export function assertResponse(
  response: SMTPResponse,
  expectedCodes: number[],
  command: string,
): void {
  if (!expectedCodes.includes(response.code)) {
    throw new SMTPError(
      `Unexpected SMTP response for ${command}`,
      response.code,
      command,
      response.message,
    );
  }
}

function applyDotStuffing(content: Uint8Array): string {
  const text = new TextDecoder().decode(content);
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const stuffed = lines.map((line) => (line.startsWith(".") ? `.${line}` : line));
  return `${stuffed.join("\r\n")}\r\n.\r\n`;
}

/** Encode AUTH LOGIN password step (second base64 chunk). */
export function encodeAuthLoginPass(pass: string): Uint8Array {
  return encodeUtf8(`${encodeBase64(pass).replace(/\r\n/g, "")}\r\n`);
}

/** Encode AUTH LOGIN user step when sent separately after 334. */
export function encodeAuthLoginUser(user: string): Uint8Array {
  return encodeUtf8(`${encodeBase64(user).replace(/\r\n/g, "")}\r\n`);
}

/** Encode CRAM-MD5 response after challenge. */
export function encodeAuthCramResponse(response: string): Uint8Array {
  return encodeUtf8(`${response}\r\n`);
}

/** Encode raw SMTP line with CRLF. */
export function encodeLine(line: string): Uint8Array {
  return encodeUtf8(`${line}\r\n`);
}
