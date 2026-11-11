// src/core/mime.ts
import {
  assertSafeAddress,
  extractEmails,
  isValidEmail,
  parseAddresses,
  toMIMEHeader,
} from "./address.js";
import { encodeBase64, encodeHeader, encodeUtf8 } from "./base64.js";
import { SentlyError } from "./errors.js";
import type { Address, Attachment, DKIMConfig, Envelope, MailOptions } from "./types.js";

/** Options that change how a MIME body is encoded. */
export interface BuildMIMEOptions {
  /**
   * When false, text is not sent as `8bit` (quoted-printable or `7bit` instead).
   * Default: true. SMTP passes false when the server did not advertise 8BITMIME.
   */
  allow8BitMime?: boolean;
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/\r\n?|\n/g, " ").trim();
}

function sanitizeAddress(addr: Address): Address {
  // Security check runs on the raw value FIRST and fails closed: any control
  // character (CR/LF/NUL/…) is rejected outright rather than stripped and
  // accepted. parseAddresses() already enforces this upstream; re-asserting
  // here keeps the function safe if it is ever called directly.
  assertSafeAddress(addr.address, "address");
  if (addr.name !== undefined) {
    assertSafeAddress(addr.name, "display name");
  }

  // Only ordinary surrounding whitespace is trimmed — the address identity is
  // never altered (no CR/LF-to-space repair).
  const address = addr.address.trim();
  if (!isValidEmail(address)) {
    throw new SentlyError(
      `Invalid email address: ${JSON.stringify(addr.address)}`,
      "INVALID_CONFIG",
    );
  }

  const sanitized: Address = { address };
  if (addr.name) {
    sanitized.name = sanitizeHeaderValue(addr.name);
  }
  return sanitized;
}

/** Result of building a complete MIME message. */
export interface MIMEBuildResult {
  /** Complete raw MIME message bytes ready to send. */
  raw: Uint8Array;
  /** SMTP envelope derived from From/To/Cc/Bcc. */
  envelope: Envelope;
  /** Message-ID assigned or supplied for the message. */
  messageId: string;
  /** Size of the raw MIME message in bytes. */
  size: number;
  /** True when a text part uses 8bit and MAIL FROM may advertise BODY=8BITMIME. */
  eightBit?: boolean;
}

const CRLF = "\r\n";

/**
 * Build a complete MIME message as a Uint8Array ready for SMTP DATA.
 * When `dkim` is provided, signs the message and prepends the DKIM-Signature header.
 */
export async function buildMIME(
  options: MailOptions,
  dkim?: DKIMConfig,
  buildOptions?: BuildMIMEOptions,
): Promise<MIMEBuildResult> {
  if (options.to === undefined || options.to === null) {
    throw new SentlyError("Missing to address", "INVALID_CONFIG");
  }
  if (options.messageId !== undefined) {
    assertHeaderToken(options.messageId, "messageId");
  }
  const fromAddrs = parseAddresses(options.from);
  const fromDomain = fromAddrs[0]?.address.split("@")[1] ?? "sently";
  const messageId = options.messageId ?? generateMessageId(fromDomain);
  const date = (options.date ?? new Date()).toUTCString();
  const toAddrs = parseAddresses(options.to);
  const ccAddrs = options.cc ? parseAddresses(options.cc) : [];

  if (fromAddrs.length === 0) {
    throw new SentlyError("Missing from address", "INVALID_CONFIG");
  }
  if (toAddrs.length === 0) {
    throw new SentlyError("Missing to address", "INVALID_CONFIG");
  }

  const envelope: Envelope = {
    from: fromAddrs[0]?.address ?? "",
    to: [
      ...extractEmails(options.to),
      ...(options.cc ? extractEmails(options.cc) : []),
      ...(options.bcc ? extractEmails(options.bcc) : []),
    ],
  };

  const attachments = options.attachments ?? [];
  const inlineAttachments = attachments.filter((a) => a.inline || a.contentId);
  const regularAttachments = attachments.filter((a) => !a.inline && !a.contentId);

  const allow8BitMime = buildOptions?.allow8BitMime ?? true;
  let root = buildSimpleBody(options, allow8BitMime);

  if (inlineAttachments.length > 0) {
    const boundary = generateBoundary();
    root = {
      contentType: `multipart/related; boundary="${boundary}"`,
      content: assembleMultipart(boundary, [
        formatNestedPart(buildSimpleBody(options, allow8BitMime)),
        ...inlineAttachments.map(formatAttachmentPart),
      ]),
    };
  }

  if (regularAttachments.length > 0) {
    const boundary = generateBoundary();
    root = {
      contentType: `multipart/mixed; boundary="${boundary}"`,
      content: assembleMultipart(boundary, [
        formatNestedPart(root),
        ...regularAttachments.map(formatAttachmentPart),
      ]),
    };
  }

  const headers: string[] = [
    foldHeader("From", fromAddrs.map((a) => toMIMEHeader(sanitizeAddress(a))).join(", ")),
    foldHeader("To", toAddrs.map((a) => toMIMEHeader(sanitizeAddress(a))).join(", ")),
  ];

  if (ccAddrs.length > 0) {
    headers.push(foldHeader("Cc", ccAddrs.map((a) => toMIMEHeader(sanitizeAddress(a))).join(", ")));
  }

  if (options.replyTo) {
    headers.push(
      foldHeader(
        "Reply-To",
        parseAddresses(options.replyTo)
          .map((a) => toMIMEHeader(sanitizeAddress(a)))
          .join(", "),
      ),
    );
  }

  headers.push(
    foldHeader("Subject", encodeHeader(sanitizeHeaderValue(options.subject))),
    foldHeader("Date", date),
    foldHeader("Message-ID", messageId),
    "MIME-Version: 1.0",
  );

  if (options.priority === "high") {
    headers.push("X-Priority: 1", "Importance: high");
  } else if (options.priority === "low") {
    headers.push("X-Priority: 5", "Importance: low");
  }

  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      headers.push(foldHeader(sanitizeHeaderValue(key), sanitizeHeaderValue(value)));
    }
  }

  headers.push(`Content-Type: ${root.contentType}`);
  if (root.contentTransferEncoding) {
    headers.push(`Content-Transfer-Encoding: ${root.contentTransferEncoding}`);
  }

  const rawText = `${headers.join(CRLF)}${CRLF}${CRLF}${root.content}`;
  let raw = encodeUtf8(rawText);

  if (dkim) {
    const { signDKIM } = await import("../dkim.js");
    const { header } = await signDKIM(raw, dkim);
    const signedText = `${header}${CRLF}${rawText}`;
    raw = encodeUtf8(signedText);
  }

  return {
    raw,
    envelope,
    messageId,
    size: raw.length,
    eightBit: root.eightBit === true || rawText.includes("Content-Transfer-Encoding: 8bit"),
  };
}

interface SimpleBody {
  contentType: string;
  contentTransferEncoding?: string;
  content: string;
  eightBit?: boolean;
}

function buildSimpleBody(options: MailOptions, allow8BitMime: boolean): SimpleBody {
  const hasText = Boolean(options.text);
  const hasHtml = Boolean(options.html);

  if (hasText && hasHtml) {
    const boundary = generateBoundary();
    return {
      contentType: `multipart/alternative; boundary="${boundary}"`,
      content: assembleMultipart(boundary, [
        formatSimplePart(
          encodeTextPart("text/plain; charset=utf-8", options.text ?? "", allow8BitMime),
        ),
        formatSimplePart(
          encodeTextPart("text/html; charset=utf-8", options.html ?? "", allow8BitMime),
        ),
      ]),
    };
  }

  if (hasHtml) {
    return encodeTextPart("text/html; charset=utf-8", options.html ?? "", allow8BitMime);
  }

  return encodeTextPart("text/plain; charset=utf-8", options.text ?? "", allow8BitMime);
}

function encodeTextPart(contentType: string, content: string, allow8BitMime: boolean): SimpleBody {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const longLine = lines.some((line) => new TextEncoder().encode(line).length > 998);
  const nonAscii = hasCodePointAbove(normalized, 0x7f);
  if (longLine || (nonAscii && !allow8BitMime)) {
    return {
      contentType,
      contentTransferEncoding: "quoted-printable",
      content: encodeQuotedPrintable(normalized),
      eightBit: false,
    };
  }
  const cte = allow8BitMime ? "8bit" : "7bit";
  return {
    contentType,
    contentTransferEncoding: cte,
    content: normalized.replace(/\n/g, "\r\n"),
    eightBit: cte === "8bit",
  };
}

function encodeQuotedPrintable(text: string): string {
  return text
    .split("\n")
    .map((line) => encodeQuotedPrintableLine(line))
    .join("\r\n");
}

function encodeQuotedPrintableLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  let out = "";
  let column = 0;
  const push = (token: string): void => {
    if (column + token.length > 75) {
      out += "=\r\n";
      column = 0;
    }
    out += token;
    column += token.length;
  };
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    const last = i === bytes.length - 1;
    const whitespace = byte === 0x20 || byte === 0x09;
    if (byte === 0x3d || byte < 0x20 || byte > 0x7e || (whitespace && last)) {
      push(`=${byte.toString(16).toUpperCase().padStart(2, "0")}`);
    } else {
      push(String.fromCharCode(byte));
    }
  }
  return out;
}

function formatSimplePart(part: SimpleBody): string {
  const headers = [`Content-Type: ${part.contentType}`];
  if (part.contentTransferEncoding) {
    headers.push(`Content-Transfer-Encoding: ${part.contentTransferEncoding}`);
  }
  return `${headers.join(CRLF)}${CRLF}${CRLF}${part.content}`;
}

function formatNestedPart(part: SimpleBody): string {
  const headers = [`Content-Type: ${part.contentType}`];
  if (part.contentTransferEncoding) {
    headers.push(`Content-Transfer-Encoding: ${part.contentTransferEncoding}`);
  }
  return `${headers.join(CRLF)}${CRLF}${CRLF}${part.content}`;
}

function formatAttachmentPart(attachment: Attachment): string {
  if (!attachment.content || typeof attachment.content === "string") {
    throw new SentlyError(
      `Attachment "${attachment.filename ?? ""}" requires Uint8Array content`,
      "INVALID_CONFIG",
    );
  }
  if (attachment.contentType !== undefined) {
    assertHeaderToken(attachment.contentType, "contentType");
  }
  if (attachment.contentId !== undefined) {
    assertHeaderToken(attachment.contentId, "contentId");
  }

  const headers = [
    `Content-Type: ${attachment.contentType ?? "application/octet-stream"}`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${attachment.inline ? "inline" : "attachment"}; ${formatFilenameParameter(attachment.filename ?? "")}`,
  ];

  if (attachment.contentId) {
    headers.push(`Content-ID: <${attachment.contentId}>`);
  }

  if (attachment.headers) {
    for (const [key, value] of Object.entries(attachment.headers)) {
      const safeKey = sanitizeHeaderValue(key);
      const safeValue = sanitizeHeaderValue(value);
      headers.push(`${safeKey}: ${safeValue}`);
    }
  }

  return `${headers.join(CRLF)}${CRLF}${CRLF}${encodeBase64(attachment.content)}`;
}

function assembleMultipart(boundary: string, parts: string[]): string {
  const segments = parts.map((part) => `--${boundary}${CRLF}${part}`);
  segments.push(`--${boundary}--`);
  return segments.join(CRLF);
}

function generateMessageId(domain: string): string {
  const safeDomain = domain.replace(/[^A-Za-z0-9.-]/g, "") || "sently";
  return `<${crypto.randomUUID()}@${safeDomain}>`;
}

function hasHeaderBreak(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0 || code === 10 || code === 13) {
      return true;
    }
  }
  return false;
}

function hasCodePointAbove(value: string, max: number): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > max) {
      return true;
    }
  }
  return false;
}

function assertHeaderToken(value: string, label: string): void {
  if (hasHeaderBreak(value)) {
    throw new SentlyError(
      `${label} contains a forbidden control character. CR, LF, and NUL are not allowed.`,
      "INVALID_CONFIG",
    );
  }
}

function formatFilenameParameter(filename: string): string {
  if (/[^\x20-\x7E]/.test(filename) || /["\\;]/.test(filename)) {
    const encoded = encodeURIComponent(filename).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return `filename*=UTF-8''${encoded}`;
  }
  return `filename="${filename}"`;
}

function generateBoundary(): string {
  const random = crypto.getRandomValues(new Uint8Array(12));
  const hex = Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("");
  return `----sently_${hex}`;
}

function foldHeader(name: string, value: string): string {
  const line = `${name}: ${value}`;
  if (line.length <= 76) {
    return line;
  }

  const chunks: string[] = [];
  let remaining = line;

  while (remaining.length > 76) {
    let breakAt = remaining.lastIndexOf(" ", 76);
    if (breakAt <= name.length + 1) {
      breakAt = 76;
    }
    chunks.push(remaining.slice(0, breakAt));
    remaining = ` ${remaining.slice(breakAt).trimStart()}`;
  }
  chunks.push(remaining);

  return chunks.join(`${CRLF} `);
}
