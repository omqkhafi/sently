import { decodeHexBytes, timingSafeEqual } from "./timing-safe-equal.js";
import type { EmailEvent } from "./types.js";
import { emailEvent, mapEventType, parseTimestamp } from "./types.js";

const MAILGUN_EVENT_MAP: Record<string, EmailEvent["type"]> = {
  accepted: "unknown",
  delivered: "delivered",
  rejected: "bounced",
  complained: "complained",
  opened: "opened",
  clicked: "clicked",
  stored: "unknown",
  unsubscribed: "unknown",
};

/** Map a Mailgun event (and failed severity) to a normalized type. */
function mapMailgunType(eventData: Record<string, unknown>): EmailEvent["type"] {
  const event = typeof eventData.event === "string" ? eventData.event : "";
  if (event === "failed") {
    return eventData.severity === "temporary" ? "deferred" : "bounced";
  }
  return mapEventType(event, MAILGUN_EVENT_MAP);
}

function extractMailgunMessageId(message: Record<string, unknown> | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  const headers = message.headers;
  if (typeof headers === "object" && headers !== null) {
    const messageId = (headers as Record<string, unknown>)["message-id"];
    if (typeof messageId === "string") {
      return messageId;
    }
  }
  return typeof message["message-id"] === "string" ? message["message-id"] : undefined;
}

/** Parse a Mailgun webhook payload into normalized {@link EmailEvent} records. */
export function parse(payload: unknown): EmailEvent[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }

  const record = payload as Record<string, unknown>;
  const eventData =
    typeof record["event-data"] === "object" && record["event-data"] !== null
      ? (record["event-data"] as Record<string, unknown>)
      : record;

  const message =
    typeof eventData.message === "object" && eventData.message !== null
      ? (eventData.message as Record<string, unknown>)
      : undefined;

  const messageId = extractMailgunMessageId(message);
  const timestamp = parseTimestamp(eventData.timestamp);

  return [
    emailEvent({
      provider: "mailgun",
      type: mapMailgunType(eventData),
      ...(messageId !== undefined ? { messageId } : {}),
      ...(typeof eventData.recipient === "string" ? { recipient: eventData.recipient } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
      raw: payload,
    }),
  ];
}

/**
 * Verify a Mailgun webhook signature using HMAC-SHA256 (Web Crypto).
 * signingKey is the Mailgun webhook signing key.
 *
 * Returns false when any argument is missing or the key is unusable.
 * `toleranceSeconds` defaults to 300. Pass `0` to disable the replay window.
 */
export async function verifySignature(
  timestamp: string,
  token: string,
  signature: string,
  signingKey: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!timestamp || !token || !signature || !signingKey) {
    return false;
  }

  if (toleranceSeconds !== 0) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) {
      return false;
    }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > toleranceSeconds) {
      return false;
    }
  }

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    return false;
  }

  const data = new TextEncoder().encode(timestamp + token);
  const expected = await crypto.subtle.sign("HMAC", key, data);
  const expectedBytes = new Uint8Array(expected);
  const providedBytes = decodeHexBytes(signature);

  if (providedBytes === null) {
    return false;
  }

  return timingSafeEqual(expectedBytes, providedBytes);
}

/**
 * Verify a Mailgun webhook payload using the nested `signature` object.
 * Returns false when the payload shape is invalid.
 */
export async function verifyPayload(payload: unknown, signingKey: string): Promise<boolean> {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  const signatureField = (payload as Record<string, unknown>).signature;
  if (typeof signatureField !== "object" || signatureField === null) {
    return false;
  }

  const signature = signatureField as Record<string, unknown>;
  if (
    typeof signature.timestamp !== "string" ||
    typeof signature.token !== "string" ||
    typeof signature.signature !== "string"
  ) {
    return false;
  }

  return verifySignature(signature.timestamp, signature.token, signature.signature, signingKey);
}
