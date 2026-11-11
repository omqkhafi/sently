/**
 * @module
 * OAuth2 / XOAUTH2 authentication for SMTP.
 * Supports Gmail, Microsoft 365, and custom OAuth2 providers.
 *
 * @example
 * ```ts
 * import { OAuth2Client } from "sently/auth/oauth2";
 * const client = new OAuth2Client({
 *   user: "me@gmail.com",
 *   clientId: "...",
 *   clientSecret: "...",
 *   refreshToken: "...",
 * });
 * const token = await client.getAccessToken();
 * ```
 */

import { encodeBase64, encodeUtf8 } from "../core/base64.js";
import { providerFetch, readJsonBody } from "../core/http.js";
import type { OAuth2Config } from "../core/types.js";

/** Default Google OAuth2 token endpoint. */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Microsoft OAuth2 token endpoint (common tenant). */
export const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

/** OAuth2 token endpoint response shape. */
export interface TokenResponse {
  /** Bearer access token for API or SMTP XOAUTH2. */
  access_token: string;
  /** Token lifetime in seconds. */
  expires_in: number;
  /** Token type (typically `"Bearer"`). */
  token_type: string;
}

const EXPIRY_BUFFER_MS = 30_000;

/**
 * OAuth2 client with in-memory token cache and automatic refresh.
 */
export class OAuth2Client {
  /** OAuth2 configuration supplied at construction. */
  private readonly config: OAuth2Config;
  /** Cached access token, or null before the first fetch. */
  private cachedToken: string | null = null;
  /** Expiry timestamp (ms) for the cached access token. */
  private expiresAt = 0;
  /** In-flight refresh promise used to deduplicate concurrent refreshes. */
  private refreshPromise: Promise<string> | null = null;

  /** Creates an OAuth2 client from configuration. */
  constructor(config: OAuth2Config) {
    this.config = config;
    if (config.accessToken) {
      this.cachedToken = config.accessToken;
      this.expiresAt = Date.now() + 3_600_000;
    }
  }

  /**
   * Get a valid access token (cached when still valid, refreshed otherwise).
   */
  async getAccessToken(): Promise<string> {
    if (this.config.getToken) {
      return this.config.getToken();
    }

    if (this.cachedToken && Date.now() < this.expiresAt - EXPIRY_BUFFER_MS) {
      return this.cachedToken;
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshAccessToken().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  /**
   * Force-refresh the access token regardless of expiry.
   */
  async refreshAccessToken(): Promise<string> {
    if (this.config.getToken) {
      const token = await this.config.getToken();
      this.cachedToken = token;
      this.expiresAt = Date.now() + 3_600_000;
      return token;
    }

    const tokenUrl = this.config.tokenUrl ?? GOOGLE_TOKEN_URL;
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
      grant_type: "refresh_token",
    });

    const response = await providerFetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OAuth2 token refresh failed (${response.status}): ${text}`);
    }

    const data = (await readJsonBody(response, "oauth2")) as TokenResponse;
    this.cachedToken = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    return data.access_token;
  }

  /**
   * Build the XOAUTH2 SASL string for SMTP AUTH (base64-encoded).
   */
  async buildXOAUTH2(): Promise<string> {
    const token = await this.getAccessToken();
    const raw = `user=${this.config.user}\x01auth=Bearer ${token}\x01\x01`;
    return encodeBase64(encodeUtf8(raw)).replace(/\r\n/g, "");
  }
}
