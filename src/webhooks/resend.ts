import { decodeBase64Bytes, timingSafeEqual } from "./timing-safe-equal.js";
import type { EmailEvent } from "./types.js";
import { emailEvent, mapEventType, parseTimestamp } from "./types.js";

const RESEND_EVENT_MAP: Record<string, EmailEvent["type"]> = {
  "email.sent": "unknown",
  "email.scheduled": "unknown",
  "email.delivered": "delivered",
  "email.delivery_delayed": "deferred",
  "email.bounced": "bounced",
  "email.failed": "bounced",
  "email.complained": "complained",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.received": "unknown",
  "email.suppressed": "unknown",
};

/** Decode a Svix signing secret (`whsec_…`) to raw key bytes. */
function decodeSvixSecret(secret: string): ArrayBuffer {
  const encoded = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  if (encoded.length === 0) {
    throw new Error("empty svix secret");
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Parse a Resend webhook payload into normalized {@link EmailEvent} records. */
export function parse(payload: unknown): EmailEvent[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }

  const record = payload as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  const data =
    typeof record.data === "object" && record.data !== null
      ? (record.data as Record<string, unknown>)
      : {};

  const to = data.to;
  const recipient = Array.isArray(to)
    ? typeof to[0] === "string"
      ? to[0]
      : undefined
    : typeof to === "string"
      ? to
      : undefined;

  const timestamp = parseTimestamp(record.created_at ?? data.created_at);

  return [
    emailEvent({
      provider: "resend",
      type: mapEventType(type, RESEND_EVENT_MAP),
      ...(typeof data.email_id === "string" ? { messageId: data.email_id } : {}),
      ...(recipient !== undefined ? { recipient } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
      raw: payload,
    }),
  ];
}

/**
 * Verify a Resend webhook signature (Svix-style) using Web Crypto.
 * Returns false when verification cannot be performed, the secret is invalid,
 * or the signature does not match.
 *
 * `toleranceSeconds` defaults to 300. Pass `0` to disable the replay window.
 */
export async function verifySignature(
  payload: string,
  headers: { "svix-id"?: string; "svix-timestamp"?: string; "svix-signature"?: string },
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  const msgId = headers["svix-id"];
  const timestamp = headers["svix-timestamp"];
  const signatureHeader = headers["svix-signature"];

  if (!msgId || !timestamp || !signatureHeader || !secret) {
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

  const signedContent = `${msgId}.${timestamp}.${payload}`;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      decodeSvixSecret(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    return false;
  }

  const expected = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
  const expectedBytes = new Uint8Array(expected);

  for (const part of signatureHeader.split(" ")) {
    const versioned = part.split(",", 2);
    const sig = versioned[1];
    if (sig === undefined) {
      continue;
    }
    const providedBytes = decodeBase64Bytes(sig);
    if (providedBytes === null) {
      continue;
    }
    if (timingSafeEqual(expectedBytes, providedBytes)) {
      return true;
    }
  }

  return false;
}
