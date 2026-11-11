// src/core/address.ts
import { encodeHeader } from "./base64.js";
import { SentlyError } from "./errors.js";
import type { Address, AddressInput } from "./types.js";

/**
 * Find the first forbidden control character in a string.
 *
 * Forbidden characters must never appear in an email address or display name,
 * because each enables a distinct attack:
 * - CR (0x0D) / LF (0x0A): email header injection and SMTP command injection
 * - NUL (0x00): C-string truncation / parser confusion in downstream agents
 * - other C0 controls (0x01–0x1F), DEL (0x7F): header/parser confusion
 * - U+2028 / U+2029: line separators that some parsers treat as newlines
 *
 * @returns The char code of the first forbidden character, or -1 if none.
 */
function findForbiddenChar(value: string): number {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) {
      return code;
    }
  }
  return -1;
}

/**
 * Assert that a raw address or display-name value contains no forbidden
 * control characters. Throws immediately (fail closed) — the library never
 * attempts to strip or rewrite hostile input into an accepted value.
 *
 * The check is intentionally performed on the RAW input, before any trimming
 * or normalization, so hostile values are rejected rather than repaired.
 *
 * @param value - The raw, untransformed string to validate.
 * @param label - Field label used in the error message (e.g. "address").
 * @throws {SentlyError} INVALID_CONFIG if the value contains any forbidden control character.
 */
export function assertSafeAddress(value: string, label = "address"): void {
  const code = findForbiddenChar(value);
  if (code !== -1) {
    const hex = code.toString(16).padStart(2, "0");
    throw new SentlyError(
      `Email ${label} contains a forbidden control character (0x${hex}). ` +
        "CR, LF, NUL, and other control characters are not allowed.",
      "INVALID_CONFIG",
    );
  }
}

/**
 * Normalize any AddressInput form into Address[].
 *
 * Every address and display name is validated against control-character
 * injection before any transformation. This is the single chokepoint shared
 * by all transports and address fields (From, To, Cc, Bcc, Reply-To), so the
 * protection is uniform and secure by default.
 *
 * @throws {Error} If any address or name contains a forbidden control character.
 */
export function parseAddresses(input: AddressInput | null | undefined): Address[] {
  if (input === undefined || input === null) {
    throw new SentlyError("Missing address", "INVALID_CONFIG");
  }
  if (Array.isArray(input)) {
    return input.flatMap((item) => parseAddresses(item));
  }

  if (typeof input === "object") {
    assertSafeAddress(input.address, "address");
    if (input.name !== undefined) {
      assertSafeAddress(input.name, "display name");
    }
    return [{ ...input }];
  }

  // Validate the raw input string before splitting or trimming so injected
  // newlines cannot hide inside a multi-address list.
  assertSafeAddress(input, "address");

  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }

  return splitAddressList(trimmed).map(parseSingleAddress);
}

/**
 * Format an Address for SMTP envelope commands (MAIL FROM / RCPT TO).
 */
export function toEnvelope(address: Address): string {
  return address.address;
}

/**
 * Format an Address for use in a MIME header (From, To, CC, etc.).
 *
 * Re-validates the address and name at render time so a header can never be
 * emitted with an embedded control character, even if the {@link Address} was
 * constructed without going through {@link parseAddresses}.
 *
 * @throws {Error} If the address or name contains a forbidden control character.
 */
export function toMIMEHeader(address: Address): string {
  assertSafeAddress(address.address, "address");
  if (address.name) {
    assertSafeAddress(address.name, "display name");
    const name = encodeHeader(address.name);
    return `${name} <${address.address}>`;
  }
  return address.address;
}

/**
 * Extract plain email strings from any AddressInput.
 */
export function extractEmails(input: AddressInput): string[] {
  return parseAddresses(input).map((addr) => addr.address);
}

/**
 * Basic email format validation (format only, no DNS lookup).
 *
 * Rejects any control character (including CR, LF, tab, and NUL) before
 * applying the structural check, so a "valid" result is always safe to place
 * into a header or SMTP command.
 */
export function isValidEmail(email: string): boolean {
  if (findForbiddenChar(email) !== -1) return false;
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email);
}

function splitAddressList(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i] ?? "";
    if (char === '"' && input[i - 1] !== "\\") {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === "<" && !inQuotes) {
      inAngle = true;
      current += char;
      continue;
    }
    if (char === ">" && !inQuotes) {
      inAngle = false;
      current += char;
      continue;
    }
    if (char === "," && !inQuotes && !inAngle) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

function parseSingleAddress(input: string): Address {
  const trimmed = input.trim();

  const angleMatch = trimmed.match(/^(?:"([^"]*)"|([^<]*?))\s*<([^>]+)>$/);
  if (angleMatch) {
    const name = (angleMatch[1] ?? angleMatch[2] ?? "").trim();
    const address = (angleMatch[3] ?? "").trim();
    if (name) {
      return { name, address };
    }
    return { address };
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return { address: trimmed.slice(1, -1) };
  }

  return { address: trimmed };
}
