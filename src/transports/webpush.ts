/**
 * @module
 * Web Push transport (RFC 8292 VAPID + RFC 8291 aes128gcm).
 *
 * VAPID keys are the common web-push raw format: base64url-encoded
 * uncompressed P-256 public key (65 bytes) and raw private key (32 bytes).
 *
 * Store `vapidPrivateKey` in a secrets manager / environment variable — never
 * hardcode it or commit it to source control.
 *
 * @example
 * ```ts
 * import { createPushSender } from "sently/push";
 * import { WebPushTransport } from "sently/transports/webpush";
 *
 * const push = createPushSender({
 *   transport: new WebPushTransport({
 *     vapidPublicKey: process.env.VAPID_PUBLIC_KEY!,
 *     vapidPrivateKey: process.env.VAPID_PRIVATE_KEY!,
 *     subject: "mailto:you@example.com",
 *   }),
 * });
 * ```
 */

import { isValidEmail } from "../core/address.js";
import { decodeBase64Url, encodeBase64Url, encodeUtf8 } from "../core/base64.js";
import { httpStatusToSentlyCode, SentlyError } from "../core/errors.js";
import { providerFetch } from "../core/http.js";
import { assertSafePushEndpoint } from "../core/push-endpoint.js";
import type {
  PushOptions,
  PushSendResult,
  PushSubscription,
  PushTransport,
  WebPushOptions,
  WebPushUrgency,
} from "../core/push-types.js";
import { isWebPushOptions } from "../core/push-types.js";
import type { VerifyResult } from "../core/types.js";

/** Web Push / VAPID configuration. */
export interface WebPushConfig {
  /** Base64url-encoded uncompressed P-256 public key (65 bytes). */
  vapidPublicKey: string;
  /**
   * Base64url-encoded raw P-256 private key (32 bytes).
   * Treat as a tier-1 secret — inject from env / secrets manager only.
   */
  vapidPrivateKey: string;
  /**
   * Contact URI for the VAPID `sub` claim. Must be a `mailto:` address
   * (e.g. `mailto:you@example.com`) or an `https:` URL
   * (e.g. `https://example.com/contact`). Validated at construction.
   */
  subject: string;
  /**
   * Extra exact hostnames allowed for `subscription.endpoint` beyond the
   * built-in FCM / Mozilla / Apple / WNS allowlist. Use for private push relays.
   */
  allowedEndpointHosts?: string[];
}

/** Generated VAPID key pair in the common web-push raw format. */
export interface VapidKeys {
  /** Base64url-encoded uncompressed P-256 public key (65 bytes). */
  publicKey: string;
  /** Base64url-encoded raw P-256 private key (32 bytes) — treat as a secret. */
  privateKey: string;
}

const WEB_PUSH_URGENCIES: ReadonlySet<WebPushUrgency> = new Set([
  "very-low",
  "low",
  "normal",
  "high",
]);

/** RFC 8030 Topic: printable ASCII, max 32 characters. */
const TOPIC_PATTERN = /^[\x21-\x7E]{1,32}$/;

/** Error thrown when a push service rejects the request. */
export class WebPushError extends SentlyError {
  /** Creates a Web Push error with HTTP status and response body. */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly apiError: unknown,
  ) {
    super(message, httpStatusToSentlyCode(statusCode), {
      statusCode,
      provider: "webpush",
      cause: apiError,
    });
    this.name = "WebPushError";
  }
}

/** Default TTL (28 days) in seconds. */
const DEFAULT_TTL_SECONDS = 2419200;
/** RFC 8188 / Web Push record size. */
const RECORD_SIZE = 4096;
/**
 * Maximum encrypted body size push services are required to accept (RFC 8291).
 * Includes salt, rs, keyid, and ciphertext+tag.
 */
const MAX_ENCRYPTED_BODY_BYTES = 4096;

/**
 * RFC 8292 VAPID `sub` must identify the sender as `mailto:` or `https:`.
 * Checked at construction so a bare handle like `@oke.local` fails here,
 * not later as an opaque 403 from a push service.
 */
function assertVapidSubject(subject: string): void {
  if (subject.startsWith("mailto:")) {
    const email = subject.slice("mailto:".length);
    if (isValidEmail(email)) {
      return;
    }
  } else if (subject.startsWith("https:")) {
    try {
      const url = new URL(subject);
      if (url.protocol === "https:" && url.hostname.length > 0) {
        return;
      }
    } catch {
      // fall through to the shared error
    }
  }

  throw new WebPushError(
    `WebPushConfig.subject must be a mailto: address or https: URL identifying you to push services, got: ${JSON.stringify(subject)}`,
    400,
    { field: "subject", value: subject },
  );
}

/**
 * Generate a VAPID key pair in the common web-push raw format
 * (base64url public + base64url private `d`).
 *
 * @example
 * ```ts
 * import { generateVapidKeys } from "sently/transports/webpush";
 *
 * const { publicKey, privateKey } = await generateVapidKeys();
 * ```
 */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const jwk = (await crypto.subtle.exportKey("jwk", keyPair.privateKey)) as JsonWebKey;
  if (typeof jwk.d !== "string" || jwk.d.length === 0) {
    throw new WebPushError("Failed to export VAPID private key", 500, { field: "privateKey" });
  }
  return {
    publicKey: encodeBase64Url(publicRaw),
    privateKey: jwk.d,
  };
}

function assertUrgency(urgency: string): asserts urgency is WebPushUrgency {
  if (!WEB_PUSH_URGENCIES.has(urgency as WebPushUrgency)) {
    throw new WebPushError(
      `Web Push urgency must be very-low, low, normal, or high, got: ${JSON.stringify(urgency)}`,
      400,
      { field: "urgency", value: urgency },
    );
  }
}

function assertTopic(topic: string): void {
  if (!TOPIC_PATTERN.test(topic)) {
    throw new WebPushError(
      `Web Push topic must be 1–32 printable ASCII characters, got: ${JSON.stringify(topic)}`,
      400,
      { field: "topic", value: topic },
    );
  }
}

/**
 * Build the JSON object encrypted for the service worker.
 * Visible notifications need `title` + `body`; silent / data-only send `data` alone.
 */
function buildWebPushPayload(options: WebPushOptions): Record<string, unknown> {
  if (options.silent) {
    if (options.data === undefined) {
      throw new WebPushError("silent Web Push requires data", 400, { field: "data" });
    }
    return { data: options.data };
  }

  const hasTitle = typeof options.title === "string" && options.title.length > 0;
  const hasBody = typeof options.body === "string" && options.body.length > 0;

  if (!hasTitle && !hasBody) {
    if (options.data === undefined) {
      throw new WebPushError(
        "Web Push requires title and body, or data for a data-only / silent send",
        400,
        { fields: ["title", "body", "data"] },
      );
    }
    return { data: options.data };
  }

  if (!hasTitle || !hasBody) {
    throw new WebPushError("Visible Web Push notifications require both title and body", 400, {
      fields: ["title", "body"],
    });
  }

  return {
    title: options.title,
    body: options.body,
    ...(options.data !== undefined ? { data: options.data } : {}),
    ...(options.icon !== undefined ? { icon: options.icon } : {}),
    ...(options.badge !== undefined ? { badge: options.badge } : {}),
    ...(options.image !== undefined ? { image: options.image } : {}),
    ...(options.tag !== undefined ? { tag: options.tag } : {}),
    ...(options.actions !== undefined ? { actions: options.actions } : {}),
    ...(options.requireInteraction !== undefined
      ? { requireInteraction: options.requireInteraction }
      : {}),
    ...(options.renotify !== undefined ? { renotify: options.renotify } : {}),
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uint32Be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function ecPublicToJwk(publicKey: Uint8Array): JsonWebKey {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new WebPushError("Invalid P-256 uncompressed public key", 400, {
      length: publicKey.length,
    });
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: encodeBase64Url(publicKey.subarray(1, 33)),
    y: encodeBase64Url(publicKey.subarray(33, 65)),
  };
}

function ecKeyPairToJwk(publicKey: Uint8Array, privateKey: Uint8Array): JsonWebKey {
  return {
    ...ecPublicToJwk(publicKey),
    d: encodeBase64Url(privateKey),
  };
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, toArrayBuffer(data));
  return new Uint8Array(sig);
}

/** HKDF-Extract + Expand (HMAC-SHA-256) for a single block (L ≤ 32). */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const prk = await hmacSha256(salt, ikm);
  const block = await hmacSha256(prk, concatBytes(info, new Uint8Array([0x01])));
  return block.subarray(0, length);
}

/**
 * Encrypt a payload per RFC 8291 (aes128gcm content coding).
 *
 * Confidence note: Implemented from RFC 8291 / RFC 8188. Tests assert header
 * shapes, framing, and size limits; full known-vector fixtures were not
 * available in-repo — treat as high-scrutiny crypto.
 */
async function encryptAes128Gcm(
  subscription: PushSubscription,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const uaPublic = decodeBase64Url(subscription.keys.p256dh);
  const authSecret = decodeBase64Url(subscription.keys.auth);

  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new WebPushError("Invalid subscription p256dh key", 400, {
      length: uaPublic.length,
    });
  }
  if (authSecret.length < 16) {
    throw new WebPushError("Invalid subscription auth key", 400, {
      length: authSecret.length,
    });
  }

  const asKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", asKeyPair.publicKey));

  const uaKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(uaPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeyPair.privateKey, 256),
  );

  const keyInfo = concatBytes(encodeUtf8("WebPush: info\0"), uaPublic, asPublicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cekInfo = encodeUtf8("Content-Encoding: aes128gcm\0");
  const nonceInfo = encodeUtf8("Content-Encoding: nonce\0");
  const cek = await hkdf(salt, ikm, cekInfo, 16);
  const nonce = await hkdf(salt, ikm, nonceInfo, 12);

  // RFC 8188 final-record padding delimiter
  const padded = concatBytes(plaintext, new Uint8Array([0x02]));

  const aesKey = await crypto.subtle.importKey("raw", toArrayBuffer(cek), "AES-GCM", false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonce) },
      aesKey,
      toArrayBuffer(padded),
    ),
  );

  // salt || rs || idlen || keyid || ciphertext
  return concatBytes(
    salt,
    uint32Be(RECORD_SIZE),
    new Uint8Array([asPublicRaw.length]),
    asPublicRaw,
    ciphertext,
  );
}

async function signVapidJwt(
  endpoint: string,
  subject: string,
  vapidPublicKey: string,
  vapidPrivateKey: string,
): Promise<string> {
  const publicKey = decodeBase64Url(vapidPublicKey);
  const privateKey = decodeBase64Url(vapidPrivateKey);
  const jwk = ecKeyPairToJwk(publicKey, privateKey);

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const origin = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  };

  const encodedHeader = encodeBase64Url(encodeUtf8(JSON.stringify(header)));
  const encodedPayload = encodeBase64Url(encodeUtf8(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      toArrayBuffer(encodeUtf8(signingInput)),
    ),
  );

  return `${signingInput}.${encodeBase64Url(signature)}`;
}

/**
 * Web Push transport — VAPID auth + RFC 8291 payload encryption.
 *
 * Endpoint URLs are validated against an allowlist before fetch to mitigate SSRF.
 * Redirects are not followed.
 */
export class WebPushTransport implements PushTransport {
  readonly provider = "webpush";

  private readonly vapidPublicKey: string;
  private readonly vapidPrivateKey: string;
  private readonly subject: string;
  private readonly allowedEndpointHosts: readonly string[];

  /** Creates a Web Push transport with VAPID credentials. */
  constructor(config: WebPushConfig) {
    assertVapidSubject(config.subject);
    this.vapidPublicKey = config.vapidPublicKey;
    this.vapidPrivateKey = config.vapidPrivateKey;
    this.subject = config.subject;
    this.allowedEndpointHosts = config.allowedEndpointHosts ?? [];
  }

  /** Encrypts and POSTs a notification to the subscription endpoint. */
  async send(options: PushOptions): Promise<PushSendResult> {
    if (!isWebPushOptions(options)) {
      throw new WebPushError(
        "WebPushTransport requires PushOptions.subscription; use FcmTransport for device tokens",
        400,
        { hint: "fcm" },
      );
    }

    try {
      assertSafePushEndpoint(options.subscription.endpoint, this.allowedEndpointHosts);
    } catch (error) {
      let endpointHost: string | undefined;
      try {
        endpointHost = new URL(options.subscription.endpoint).hostname;
      } catch {
        endpointHost = undefined;
      }
      throw new WebPushError(
        error instanceof Error ? error.message : "Unsafe push subscription endpoint",
        400,
        { endpointHost },
      );
    }

    if (options.urgency !== undefined) {
      assertUrgency(options.urgency);
    }
    if (options.topic !== undefined) {
      assertTopic(options.topic);
    }

    const notification = buildWebPushPayload(options);
    const plaintext = encodeUtf8(JSON.stringify(notification));
    const encrypted = await encryptAes128Gcm(options.subscription, plaintext);

    if (encrypted.length > MAX_ENCRYPTED_BODY_BYTES) {
      throw new WebPushError(
        `Encrypted push payload exceeds ${MAX_ENCRYPTED_BODY_BYTES} bytes (RFC 8291)`,
        413,
        { size: encrypted.length },
      );
    }

    const jwt = await signVapidJwt(
      options.subscription.endpoint,
      this.subject,
      this.vapidPublicKey,
      this.vapidPrivateKey,
    );

    const ttl = options.ttl ?? DEFAULT_TTL_SECONDS;
    const headers: Record<string, string> = {
      Authorization: `vapid t=${jwt}, k=${this.vapidPublicKey}`,
      "Content-Encoding": "aes128gcm",
      TTL: String(ttl),
      "Content-Type": "application/octet-stream",
    };
    if (options.urgency !== undefined) {
      headers.Urgency = options.urgency;
    }
    if (options.topic !== undefined) {
      headers.Topic = options.topic;
    }

    const response = await providerFetch(options.subscription.endpoint, {
      method: "POST",
      redirect: "manual",
      headers,
      body: toArrayBuffer(encrypted),
    });

    // Opaque redirect responses (3xx) must not be followed — SSRF mitigation.
    if (response.status >= 300 && response.status < 400) {
      throw new WebPushError(
        `Push service returned redirect ${response.status}; redirects are not followed`,
        response.status,
        { location: response.headers.get("location") },
      );
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new WebPushError(
        bodyText || `Web Push request failed with status ${response.status}`,
        response.status,
        bodyText || { status: response.status },
      );
    }

    return {
      messageId: options.messageId ?? crypto.randomUUID(),
      status: "accepted",
      response: String(response.status),
      provider: "webpush",
    };
  }

  /** Lightweight VAPID credential shape check. */
  async verify(): Promise<VerifyResult> {
    try {
      const pub = decodeBase64Url(this.vapidPublicKey);
      const priv = decodeBase64Url(this.vapidPrivateKey);
      const ok = pub.length === 65 && priv.length === 32 && this.subject.length > 0;
      return {
        ok,
        provider: "webpush",
        message: ok ? "VAPID credentials present" : "Invalid VAPID key lengths",
      };
    } catch (error) {
      return {
        ok: false,
        provider: "webpush",
        message: error instanceof Error ? error.message : "Invalid VAPID credentials",
      };
    }
  }
}
