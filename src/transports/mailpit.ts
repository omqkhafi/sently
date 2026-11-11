/**
 * @module
 * Mailpit development transport — SMTP to a local Mailpit catcher with
 * REST helpers for inspecting, searching, and checking captured messages.
 *
 * Defaults match a stock Mailpit install: SMTP `localhost:1025`,
 * UI/API `http://localhost:8025`.
 *
 * @example
 * ```ts
 * import { createMailer } from "sently/mailer";
 * import { MailpitTransport } from "sently/transports/mailpit";
 *
 * const mailpit = new MailpitTransport();
 * const mailer = await createMailer({ transport: mailpit });
 *
 * await mailer.send({
 *   from: "dev@example.com",
 *   to: "you@example.com",
 *   subject: "Hello",
 *   text: "Captured by Mailpit",
 * });
 *
 * const inbox = await mailpit.messages();
 * console.log(inbox.messages[0]?.Subject);
 * ```
 */

import { encodeBase64 } from "../core/base64.js";
import { httpStatusToSentlyCode, SentlyError } from "../core/errors.js";
import { providerFetch, readJsonBody } from "../core/http.js";
import type {
  MailOptions,
  SendResult,
  SMTPAuth,
  SocketAdapter,
  TLSOptions,
  Transport,
  VerifyResult,
} from "../core/types.js";
import { createDefaultAdapter } from "../detect.js";
import { SMTPTransport } from "./smtp.js";

/** Default SMTP host for a local Mailpit instance. */
export const MAILPIT_DEFAULT_HOST = "localhost";

/** Default SMTP port for a local Mailpit instance. */
export const MAILPIT_DEFAULT_PORT = 1025;

/** Default web UI / REST API base URL for a local Mailpit instance. */
export const MAILPIT_DEFAULT_API_URL = "http://localhost:8025";

/** Mailpit development transport configuration. */
export interface MailpitConfig {
  /** SMTP hostname. Default: `"localhost"`. */
  host?: string;
  /** SMTP port. Default: `1025`. */
  port?: number;
  /** Use implicit TLS on connect. Default: `false` (Mailpit is plain SMTP). */
  secure?: boolean;
  /**
   * Refuse AUTH over a non-TLS connection.
   * Default: `false` so optional local SMTP auth works without TLS.
   */
  requireTLS?: boolean;
  /** Optional SMTP authentication (Mailpit can accept any credentials). */
  auth?: SMTPAuth;
  /** TLS options when STARTTLS or implicit TLS is enabled. */
  tls?: TLSOptions;
  /** Socket connect timeout in milliseconds. */
  connectionTimeout?: number;
  /** Runtime socket adapter. Auto-detected on first send when omitted. */
  adapter?: SocketAdapter;
  /**
   * Mailpit web UI / REST API base URL (no trailing slash).
   * Default: `"http://localhost:8025"`.
   */
  apiUrl?: string;
  /** Basic auth for the Mailpit UI/API when the instance requires it. */
  apiAuth?: { user: string; pass: string };
}

/** Address object returned by the Mailpit REST API. */
export interface MailpitAddress {
  /** Display name, may be empty. */
  Name: string;
  /** Email address. */
  Address: string;
}

/** Summary row from `GET /api/v1/messages` / `GET /api/v1/search`. */
export interface MailpitMessageSummary {
  /** Mailpit message id. */
  ID: string;
  /** MIME Message-ID. */
  MessageID: string;
  /** Sender. */
  From: MailpitAddress;
  /** Recipients. */
  To: MailpitAddress[];
  /** Subject line. */
  Subject: string;
  /** ISO created timestamp. */
  Created: string;
  /** Attachment count. */
  Attachments: number;
  /** Whether the message has been read in the UI. */
  Read: boolean;
  /** Short plain-text snippet. */
  Snippet: string;
}

/** Response from `GET /api/v1/messages` / `GET /api/v1/search`. */
export interface MailpitMessageList {
  /** Total messages stored (or matching the search). */
  total: number;
  /** Unread message count. */
  unread: number;
  /** Messages returned in this page. */
  count: number;
  /** Message summaries (newest first). */
  messages: MailpitMessageSummary[];
}

/** Full message from `GET /api/v1/message/{id}`. */
export interface MailpitMessage {
  /** Mailpit message id. */
  ID: string;
  /** MIME Message-ID. */
  MessageID: string;
  /** Sender. */
  From: MailpitAddress;
  /** Recipients. */
  To: MailpitAddress[];
  /** CC recipients. */
  Cc?: MailpitAddress[];
  /** BCC recipients. */
  Bcc?: MailpitAddress[];
  /** Subject line. */
  Subject: string;
  /** Plain-text body. */
  Text: string;
  /** HTML body. */
  HTML: string;
  /** ISO created timestamp. */
  Date: string;
  /** Attachment count. */
  Attachments: number;
}

/**
 * Message headers from `GET /api/v1/message/{id}/headers`.
 * Keys are header names; values are one or more header lines.
 */
export type MailpitHeaders = Record<string, string[]>;

/** Aggregate counts from {@link MailpitHtmlCheck}. */
export interface MailpitHtmlCheckTotal {
  /** Node count in the HTML. */
  Nodes: number;
  /** Partially supported checks. */
  Partial: number;
  /** Fully supported checks. */
  Supported: number;
  /** Total checks run. */
  Tests: number;
  /** Unsupported checks. */
  Unsupported: number;
}

/** One warning row from Mailpit’s HTML checker. */
export interface MailpitHtmlCheckWarning {
  /** Warning category. */
  Category: string;
  /** Human-readable description. */
  Description: string;
  /** Keyword summary. */
  Keywords: string;
  /** Title. */
  Title: string;
  /** caniemail.com URL when present. */
  URL: string;
  /** Per-platform support breakdown. */
  Score: {
    Found: number;
    Partial: number;
    Supported: number;
    Unsupported: number;
  };
}

/** Response from `GET /api/v1/message/{id}/html-check`. */
export interface MailpitHtmlCheck {
  /** Platforms covered by the check. */
  Platforms: Record<string, string[]>;
  /** Aggregate support totals. */
  Total: MailpitHtmlCheckTotal;
  /** Individual warnings. */
  Warnings: MailpitHtmlCheckWarning[];
}

/** One link result from Mailpit’s link checker. */
export interface MailpitLinkCheckItem {
  /** Status label (e.g. `"OK"`, `"Error"`). */
  Status: string;
  /** HTTP status code when available. */
  StatusCode: number;
  /** Checked URL. */
  URL: string;
}

/** Response from `GET /api/v1/message/{id}/link-check`. */
export interface MailpitLinkCheck {
  /** Number of failing links. */
  Errors: number;
  /** Per-URL results. */
  Links: MailpitLinkCheckItem[];
}

/** Options for {@link MailpitTransport.messages} / {@link MailpitTransport.search}. */
export interface MailpitMessagesOptions {
  /** Max messages to return. */
  limit?: number;
  /** Pagination offset. */
  start?: number;
}

/** Options for {@link MailpitTransport.linkCheck}. */
export interface MailpitLinkCheckOptions {
  /** Follow HTTP redirects when checking links. Default: `false`. */
  follow?: boolean;
}

/** Error thrown when the Mailpit REST API returns a non-success response. */
export class MailpitError extends SentlyError {
  /** Creates a Mailpit API error with status code (`0` = network/connect failure). */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly apiError: unknown,
  ) {
    super(message, statusCode === 0 ? "CONNECTION_FAILED" : httpStatusToSentlyCode(statusCode), {
      ...(statusCode > 0 ? { statusCode } : {}),
      provider: "mailpit",
      cause: apiError,
    });
    this.name = "MailpitError";
  }
}

/**
 * Development transport for [Mailpit](https://github.com/axllent/mailpit).
 *
 * Sends via SMTP (defaults: `localhost:1025`) and exposes REST helpers for
 * listing, searching, reading, checking, and deleting captured messages.
 */
export class MailpitTransport implements Transport {
  readonly provider = "mailpit";

  private readonly host: string;
  private readonly port: number;
  private readonly secure: boolean;
  private readonly requireTLS: boolean;
  private readonly auth?: SMTPAuth;
  private readonly tls?: TLSOptions;
  private readonly connectionTimeout?: number;
  private readonly adapter?: SocketAdapter;
  private readonly apiUrl: string;
  private readonly apiAuth?: { user: string; pass: string };

  private smtp: SMTPTransport | null = null;

  /** Creates a Mailpit transport with local-dev defaults. */
  constructor(config: MailpitConfig = {}) {
    this.host = config.host ?? MAILPIT_DEFAULT_HOST;
    this.port = config.port ?? MAILPIT_DEFAULT_PORT;
    this.secure = config.secure ?? false;
    this.requireTLS = config.requireTLS ?? false;
    if (config.auth !== undefined) {
      this.auth = config.auth;
    }
    if (config.tls !== undefined) {
      this.tls = config.tls;
    }
    if (config.connectionTimeout !== undefined) {
      this.connectionTimeout = config.connectionTimeout;
    }
    if (config.adapter !== undefined) {
      this.adapter = config.adapter;
    }
    this.apiUrl = (config.apiUrl ?? MAILPIT_DEFAULT_API_URL).replace(/\/$/, "");
    if (config.apiAuth !== undefined) {
      this.apiAuth = config.apiAuth;
    }
  }

  /** Web UI base URL (same origin as the REST API). */
  get webUrl(): string {
    return this.apiUrl;
  }

  /** Sends an email to Mailpit over SMTP. */
  async send(options: MailOptions): Promise<SendResult> {
    return (await this.getSmtp()).send(options);
  }

  /** Verifies SMTP connectivity to Mailpit. */
  async verify(): Promise<VerifyResult> {
    const result = await (await this.getSmtp()).verify();
    return {
      ...result,
      provider: "mailpit",
    };
  }

  /** Closes the underlying SMTP adapter if connected. */
  async close(): Promise<void> {
    if (this.smtp) {
      await this.smtp.close();
    }
  }

  /**
   * Lists captured messages via `GET /api/v1/messages`.
   * Newest messages appear first.
   */
  async messages(options: MailpitMessagesOptions = {}): Promise<MailpitMessageList> {
    return this.apiJson<MailpitMessageList>("GET", this.listPath("/api/v1/messages", options));
  }

  /**
   * Searches captured messages via `GET /api/v1/search`.
   * Query syntax matches the Mailpit UI (`subject:`, `to:`, `tag:`, …).
   */
  async search(query: string, options: MailpitMessagesOptions = {}): Promise<MailpitMessageList> {
    if (!query) {
      throw new MailpitError("Search query is required", 400, { code: "INVALID_CONFIG" });
    }
    const params = new URLSearchParams();
    params.set("query", query);
    if (options.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    if (options.start !== undefined) {
      params.set("start", String(options.start));
    }
    return this.apiJson<MailpitMessageList>("GET", `/api/v1/search?${params.toString()}`);
  }

  /**
   * Fetches a full message via `GET /api/v1/message/{id}`.
   * Pass `"latest"` for the newest message.
   */
  async getMessage(id: string): Promise<MailpitMessage> {
    return this.apiJson<MailpitMessage>("GET", `/api/v1/message/${this.encodeId(id)}`);
  }

  /**
   * Fetches message headers via `GET /api/v1/message/{id}/headers`.
   * Pass `"latest"` for the newest message.
   */
  async getHeaders(id: string): Promise<MailpitHeaders> {
    return this.apiJson<MailpitHeaders>("GET", `/api/v1/message/${this.encodeId(id)}/headers`);
  }

  /**
   * Runs Mailpit’s HTML/CSS client-compatibility check via
   * `GET /api/v1/message/{id}/html-check`.
   * Pass `"latest"` for the newest message.
   */
  async htmlCheck(id: string): Promise<MailpitHtmlCheck> {
    return this.apiJson<MailpitHtmlCheck>("GET", `/api/v1/message/${this.encodeId(id)}/html-check`);
  }

  /**
   * Runs Mailpit’s link checker via `GET /api/v1/message/{id}/link-check`.
   * Pass `"latest"` for the newest message.
   */
  async linkCheck(id: string, options: MailpitLinkCheckOptions = {}): Promise<MailpitLinkCheck> {
    const params = new URLSearchParams();
    if (options.follow === true) {
      params.set("follow", "true");
    }
    const query = params.toString();
    const path = `/api/v1/message/${this.encodeId(id)}/link-check${query ? `?${query}` : ""}`;
    return this.apiJson<MailpitLinkCheck>("GET", path);
  }

  /**
   * Sets read status via `PUT /api/v1/messages`.
   * Pass an empty `ids` array to update every message in the mailbox.
   */
  async setRead(ids: string[], read: boolean): Promise<void> {
    await this.apiOk("PUT", "/api/v1/messages", { IDs: ids, Read: read });
  }

  /**
   * Deletes messages by id via `DELETE /api/v1/messages`.
   * Pass an empty array (or call {@link deleteAll}) to clear the inbox.
   */
  async deleteMessages(ids: string[]): Promise<void> {
    await this.apiOk("DELETE", "/api/v1/messages", { IDs: ids });
  }

  /** Deletes every captured message. */
  async deleteAll(): Promise<void> {
    await this.deleteMessages([]);
  }

  private listPath(base: string, options: MailpitMessagesOptions): string {
    const params = new URLSearchParams();
    if (options.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    if (options.start !== undefined) {
      params.set("start", String(options.start));
    }
    const query = params.toString();
    return query ? `${base}?${query}` : base;
  }

  private encodeId(id: string): string {
    if (!id) {
      throw new MailpitError("Message id is required", 400, { code: "INVALID_CONFIG" });
    }
    return encodeURIComponent(id);
  }

  private async getSmtp(): Promise<SMTPTransport> {
    if (!this.smtp) {
      const adapter =
        this.adapter ??
        (await createDefaultAdapter({
          secure: this.secure,
          ...(this.connectionTimeout !== undefined
            ? { connectionTimeout: this.connectionTimeout }
            : {}),
          ...(this.tls !== undefined ? { tls: this.tls } : {}),
        }));

      this.smtp = new SMTPTransport({
        host: this.host,
        port: this.port,
        secure: this.secure,
        requireTLS: this.requireTLS,
        adapter,
        ...(this.auth !== undefined ? { auth: this.auth } : {}),
        ...(this.tls !== undefined ? { tls: this.tls } : {}),
        ...(this.connectionTimeout !== undefined
          ? { connectionTimeout: this.connectionTimeout }
          : {}),
      });
    }
    return this.smtp;
  }

  private apiHeaders(): HeadersInit {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (this.apiAuth) {
      const token = encodeBase64(`${this.apiAuth.user}:${this.apiAuth.pass}`).replace(/\r\n/g, "");
      headers.Authorization = `Basic ${token}`;
    }
    return headers;
  }

  private async apiFetch(method: string, path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await providerFetch(`${this.apiUrl}${path}`, {
        method,
        headers: this.apiHeaders(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new MailpitError(
        err instanceof Error ? err.message : "Mailpit API request failed",
        0,
        err,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new MailpitError(
        text || `Mailpit API error (${response.status})`,
        response.status,
        text,
      );
    }

    return response;
  }

  private async apiJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.apiFetch(method, path, body);
    return (await readJsonBody(response, "mailpit")) as T;
  }

  private async apiOk(method: string, path: string, body?: unknown): Promise<void> {
    await this.apiFetch(method, path, body);
  }
}
