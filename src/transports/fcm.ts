/**
 * @module
 * Firebase Cloud Messaging HTTP v1 transport for mobile push.
 *
 * Authenticates with a Google service-account JWT (RS256) exchanged for an
 * OAuth2 access token — zero runtime dependencies.
 *
 * Sently-first: wire into {@link createPushSender} with {@link FcmPushOptions}
 * (`token`, not a Web Push subscription).
 *
 * @example
 * ```ts
 * import { createPushSender } from "sently/push";
 * import { FcmTransport } from "sently/transports/fcm";
 *
 * const push = createPushSender({
 *   transport: new FcmTransport({
 *     projectId: process.env.FCM_PROJECT_ID!,
 *     clientEmail: process.env.FCM_CLIENT_EMAIL!,
 *     privateKey: process.env.FCM_PRIVATE_KEY!,
 *   }),
 * });
 *
 * await push.send({
 *   token: deviceToken,
 *   title: "Hello",
 *   body: "World",
 * });
 * ```
 */

import { encodeBase64Url, encodeUtf8 } from "../core/base64.js";
import { httpStatusToSentlyCode, SentlyError } from "../core/errors.js";
import { providerFetch } from "../core/http.js";
import type {
  FcmPushOptions,
  PushOptions,
  PushSendResult,
  PushTransport,
} from "../core/push-types.js";
import { isFcmPushOptions } from "../core/push-types.js";
import type { VerifyResult } from "../core/types.js";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Firebase service-account credentials for FCM HTTP v1. */
export interface FcmConfig {
  /** Firebase / GCP project ID. */
  projectId: string;
  /**
   * Service account `client_email`.
   * Store in environment variables — never hardcode.
   */
  clientEmail: string;
  /**
   * Service account PEM private key (`-----BEGIN PRIVATE KEY-----`…).
   * Treat as a tier-1 secret — inject from env / secrets manager only.
   * Literal `\n` sequences in env strings are normalized to newlines.
   */
  privateKey: string;
  /**
   * Optional injectable access-token provider (testing / custom auth).
   * When set, service-account JWT exchange is skipped.
   */
  getAccessToken?: () => Promise<string>;
}

/** Error thrown when the FCM HTTP v1 API rejects a request. */
export class FcmError extends SentlyError {
  /** Creates an FCM API error with status code and response payload. */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly apiError: unknown,
  ) {
    super(message, httpStatusToSentlyCode(statusCode), {
      statusCode,
      provider: "fcm",
      cause: apiError,
    });
    this.name = "FcmError";
  }
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

/**
 * FCM HTTP v1 transport — device-token push for Android / iOS / web clients.
 */
export class FcmTransport implements PushTransport {
  readonly provider = "fcm";

  private readonly projectId: string;
  private readonly clientEmail: string;
  private readonly privateKeyPem: string;
  private readonly getAccessTokenOverride: (() => Promise<string>) | undefined;
  private cached: CachedToken | undefined;
  private cryptoKey: CryptoKey | undefined;

  /** Creates an FCM transport from service-account credentials. */
  constructor(config: FcmConfig) {
    this.projectId = config.projectId;
    this.clientEmail = config.clientEmail;
    this.privateKeyPem = normalizePem(config.privateKey);
    this.getAccessTokenOverride = config.getAccessToken;
  }

  /**
   * Sends via `POST https://fcm.googleapis.com/v1/projects/{projectId}/messages:send`.
   * Requires {@link FcmPushOptions} (`token`).
   */
  async send(options: PushOptions): Promise<PushSendResult> {
    if (!isFcmPushOptions(options)) {
      throw new FcmError(
        "FcmTransport requires PushOptions.token; use WebPushTransport for browser subscriptions",
        400,
        { hint: "webpush" },
      );
    }
    if (options.token.trim().length === 0) {
      throw new FcmError("FCM device token must not be empty", 400, { field: "token" });
    }

    const accessToken = await this.getAccessToken();
    const message = buildFcmMessage(options);
    const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/messages:send`;

    const response = await providerFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    });

    const text = await response.text();
    let payload: { name?: string; error?: { message?: string; status?: string; code?: number } };
    try {
      payload = text.length > 0 ? (JSON.parse(text) as typeof payload) : {};
    } catch {
      throw new FcmError("FCM returned non-JSON response", response.status, text);
    }

    if (!response.ok) {
      throw new FcmError(
        payload.error?.message ?? `FCM API error (${response.status})`,
        response.status,
        payload,
      );
    }

    // Response name looks like projects/.../messages/{id}
    const name = typeof payload.name === "string" ? payload.name : "";
    const messageId = name.split("/").pop() || options.messageId || name || crypto.randomUUID();

    return {
      messageId,
      status: "accepted",
      response: name || String(response.status),
      provider: "fcm",
    };
  }

  /** Lightweight credential check (does not call Google). */
  async verify(): Promise<VerifyResult> {
    if (this.getAccessTokenOverride) {
      return { ok: true, provider: "fcm", message: "Custom getAccessToken configured" };
    }
    const ok = Boolean(this.projectId && this.clientEmail && this.privateKeyPem);
    return {
      ok,
      provider: "fcm",
      message: ok ? "Credentials present" : "Missing projectId, clientEmail, or privateKey",
    };
  }

  private async getAccessToken(): Promise<string> {
    if (this.getAccessTokenOverride) {
      return this.getAccessTokenOverride();
    }

    const now = Date.now();
    if (this.cached && now < this.cached.expiresAtMs - 60_000) {
      return this.cached.accessToken;
    }

    const jwt = await this.signServiceAccountJwt();
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    });

    const response = await providerFetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const text = await response.text();
    let payload: { access_token?: string; expires_in?: number; error?: string };
    try {
      payload = text.length > 0 ? (JSON.parse(text) as typeof payload) : {};
    } catch {
      throw new FcmError("OAuth token endpoint returned non-JSON", response.status, text);
    }

    if (!response.ok || typeof payload.access_token !== "string") {
      throw new FcmError(
        payload.error ?? "Failed to obtain FCM access token",
        response.status,
        payload,
      );
    }

    const expiresInSec = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
    this.cached = {
      accessToken: payload.access_token,
      expiresAtMs: now + expiresInSec * 1000,
    };
    return payload.access_token;
  }

  private async signServiceAccountJwt(): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const claims = {
      iss: this.clientEmail,
      scope: FCM_SCOPE,
      aud: TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    };

    const encodedHeader = encodeBase64Url(encodeUtf8(JSON.stringify(header)));
    const encodedClaims = encodeBase64Url(encodeUtf8(JSON.stringify(claims)));
    const signingInput = `${encodedHeader}.${encodedClaims}`;

    const key = await this.getCryptoKey();
    const signature = await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      toArrayBuffer(encodeUtf8(signingInput)),
    );

    return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
  }

  private async getCryptoKey(): Promise<CryptoKey> {
    if (this.cryptoKey) {
      return this.cryptoKey;
    }
    const der = pemToDer(this.privateKeyPem);
    this.cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      toArrayBuffer(der),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return this.cryptoKey;
  }
}

function buildFcmMessage(options: FcmPushOptions): Record<string, unknown> {
  const notification: Record<string, string> = {
    title: options.title,
    body: options.body,
  };
  if (options.image !== undefined) {
    notification.image = options.image;
  }

  const message: Record<string, unknown> = {
    token: options.token,
    notification,
  };

  if (options.data !== undefined) {
    message.data = stringifyData(options.data);
  }

  if (options.ttl !== undefined) {
    message.android = { ttl: `${options.ttl}s` };
  }

  return message;
}

function stringifyData(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out;
}

function normalizePem(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

function pemToDer(pem: string): Uint8Array {
  const lines = pem
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(lines);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    der[i] = binary.charCodeAt(i);
  }
  return der;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
