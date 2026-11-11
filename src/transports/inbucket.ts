/**
 * @module
 * Inbucket development transport — SMTP to a local Inbucket catcher with
 * REST helpers for inspecting, reading, and purging mailbox messages.
 *
 * Defaults match a stock Inbucket install: SMTP `localhost:2500`,
 * UI/API `http://localhost:9000`.
 *
 * @example
 * ```ts
 * import { createMailer } from "sently/mailer";
 * import { InbucketTransport } from "sently/transports/inbucket";
 *
 * const inbucket = new InbucketTransport();
 * const mailer = await createMailer({ transport: inbucket });
 *
 * await mailer.send({
 *   from: "dev@example.com",
 *   to: "you@example.com",
 *   subject: "Hello",
 *   text: "Captured by Inbucket",
 * });
 *
 * const mailbox = inbucket.mailboxForAddress("you@example.com");
 * const inbox = await inbucket.listMailbox(mailbox);
 * console.log(inbox[0]?.subject);
 * ```
 */

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

/** Default SMTP host for a local Inbucket instance. */
export const INBUCKET_DEFAULT_HOST = "localhost";

/** Default SMTP port for a local Inbucket instance. */
export const INBUCKET_DEFAULT_PORT = 2500;

/** Default web UI / REST API base URL for a local Inbucket instance. */
export const INBUCKET_DEFAULT_API_URL = "http://localhost:9000";

/**
 * How Inbucket maps an email address to a mailbox name.
 * Matches `INBUCKET_MAILBOXNAMING` on the catcher (`local` by default).
 */
export type InbucketMailboxNaming = "local" | "full" | "domain";

/** Inbucket development transport configuration. */
export interface InbucketConfig {
  /** SMTP hostname. Default: `"localhost"`. */
  host?: string;
  /** SMTP port. Default: `2500`. */
  port?: number;
  /** Use implicit TLS on connect. Default: `false` (Inbucket is plain SMTP). */
  secure?: boolean;
  /**
   * Refuse AUTH over a non-TLS connection.
   * Default: `false` so optional local SMTP auth works without TLS.
   */
  requireTLS?: boolean;
  /** Optional SMTP authentication. */
  auth?: SMTPAuth;
  /** TLS options when STARTTLS or implicit TLS is enabled. */
  tls?: TLSOptions;
  /** Socket connect timeout in milliseconds. */
  connectionTimeout?: number;
  /** Runtime socket adapter. Auto-detected on first send when omitted. */
  adapter?: SocketAdapter;
  /**
   * Inbucket web UI / REST API base URL (no trailing slash).
   * Default: `"http://localhost:9000"`.
   */
  apiUrl?: string;
  /**
   * Mailbox naming strategy for {@link InbucketTransport.mailboxForAddress}.
   * Default: `"local"` (local-part only), matching stock Inbucket.
   */
  mailboxNaming?: InbucketMailboxNaming;
}

/** Summary row from `GET /api/v1/mailbox/{name}`. */
export interface InbucketMessageHeader {
  /** Mailbox name. */
  mailbox: string;
  /** Inbucket message id. */
  id: string;
  /** Sender address string. */
  from: string;
  /** Recipient address strings. */
  to: string[];
  /** Subject line. */
  subject: string;
  /** ISO created timestamp. */
  date: string;
  /** Unix epoch milliseconds. */
  "posix-millis": number;
  /** Message size in bytes. */
  size: number;
  /** Whether the message has been seen in the UI/API. */
  seen: boolean;
}

/** Attachment metadata from a full Inbucket message. */
export interface InbucketAttachment {
  /** Attachment filename. */
  filename: string;
  /** MIME content type. */
  "content-type": string;
  /** Absolute download URL served by Inbucket. */
  "download-link": string;
  /** Absolute view URL served by Inbucket. */
  "view-link": string;
  /** MD5 checksum of the attachment bytes. */
  md5: string;
}

/** Body parts from a full Inbucket message. */
export interface InbucketMessageBody {
  /** Plain-text body. */
  text: string;
  /** HTML body. */
  html: string;
}

/** Full message from `GET /api/v1/mailbox/{name}/{id}`. */
export interface InbucketMessage extends InbucketMessageHeader {
  /** Text and HTML bodies. */
  body: InbucketMessageBody;
  /** Parsed header map. */
  header: Record<string, string[]>;
  /** Attachments (may be empty). */
  attachments: InbucketAttachment[];
}

/** Error thrown when the Inbucket REST API returns a non-success response. */
export class InbucketError extends SentlyError {
  /** Creates an Inbucket API error with status code (`0` = network/connect failure). */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly apiError: unknown,
  ) {
    super(message, statusCode === 0 ? "CONNECTION_FAILED" : httpStatusToSentlyCode(statusCode), {
      ...(statusCode > 0 ? { statusCode } : {}),
      provider: "inbucket",
      cause: apiError,
    });
    this.name = "InbucketError";
  }
}

/**
 * Development transport for [Inbucket](https://inbucket.org/).
 *
 * Sends via SMTP (defaults: `localhost:2500`) and exposes REST helpers for
 * listing, reading, marking seen, deleting, and purging mailbox messages.
 */
export class InbucketTransport implements Transport {
  readonly provider = "inbucket";

  private readonly host: string;
  private readonly port: number;
  private readonly secure: boolean;
  private readonly requireTLS: boolean;
  private readonly auth?: SMTPAuth;
  private readonly tls?: TLSOptions;
  private readonly connectionTimeout?: number;
  private readonly adapter?: SocketAdapter;
  private readonly apiUrl: string;
  private readonly mailboxNaming: InbucketMailboxNaming;

  private smtp: SMTPTransport | null = null;

  /** Creates an Inbucket transport with local-dev defaults. */
  constructor(config: InbucketConfig = {}) {
    this.host = config.host ?? INBUCKET_DEFAULT_HOST;
    this.port = config.port ?? INBUCKET_DEFAULT_PORT;
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
    this.apiUrl = (config.apiUrl ?? INBUCKET_DEFAULT_API_URL).replace(/\/$/, "");
    this.mailboxNaming = config.mailboxNaming ?? "local";
  }

  /** Web UI base URL (same origin as the REST API). */
  get webUrl(): string {
    return this.apiUrl;
  }

  /** Sends an email to Inbucket over SMTP. */
  async send(options: MailOptions): Promise<SendResult> {
    return (await this.getSmtp()).send(options);
  }

  /** Verifies SMTP connectivity to Inbucket. */
  async verify(): Promise<VerifyResult> {
    const result = await (await this.getSmtp()).verify();
    return {
      ...result,
      provider: "inbucket",
    };
  }

  /** Closes the underlying SMTP adapter if connected. */
  async close(): Promise<void> {
    if (this.smtp) {
      await this.smtp.close();
    }
  }

  /**
   * Maps an email address to an Inbucket mailbox name using {@link mailboxNaming}.
   * Stock Inbucket uses `"local"` (the part before `@`).
   */
  mailboxForAddress(address: string): string {
    const trimmed = address.trim();
    if (!trimmed) {
      throw new InbucketError("Email address is required", 400, { code: "INVALID_CONFIG" });
    }
    const at = trimmed.lastIndexOf("@");
    if (at <= 0 || at === trimmed.length - 1) {
      throw new InbucketError(`Invalid email address: ${address}`, 400, {
        code: "INVALID_CONFIG",
      });
    }
    const local = trimmed.slice(0, at);
    const domain = trimmed.slice(at + 1);
    switch (this.mailboxNaming) {
      case "full":
        return trimmed.toLowerCase();
      case "domain":
        return domain.toLowerCase();
      default:
        return local.toLowerCase();
    }
  }

  /**
   * Lists messages in a mailbox via `GET /api/v1/mailbox/{name}`.
   * Newest messages appear last in a stock Inbucket response.
   */
  async listMailbox(mailbox: string): Promise<InbucketMessageHeader[]> {
    return this.apiJson<InbucketMessageHeader[]>(
      "GET",
      `/api/v1/mailbox/${this.encodeSegment(mailbox, "Mailbox name")}`,
    );
  }

  /**
   * Fetches a full message via `GET /api/v1/mailbox/{name}/{id}`.
   */
  async getMessage(mailbox: string, id: string): Promise<InbucketMessage> {
    return this.apiJson<InbucketMessage>(
      "GET",
      `/api/v1/mailbox/${this.encodeSegment(mailbox, "Mailbox name")}/${this.encodeSegment(id, "Message id")}`,
    );
  }

  /**
   * Fetches the raw message source via `GET /api/v1/mailbox/{name}/{id}/source`.
   */
  async getSource(mailbox: string, id: string): Promise<string> {
    const response = await this.apiFetch(
      "GET",
      `/api/v1/mailbox/${this.encodeSegment(mailbox, "Mailbox name")}/${this.encodeSegment(id, "Message id")}/source`,
    );
    return response.text();
  }

  /**
   * Marks a message as seen via `PATCH /api/v1/mailbox/{name}/{id}`.
   */
  async markSeen(mailbox: string, id: string): Promise<void> {
    await this.apiOk(
      "PATCH",
      `/api/v1/mailbox/${this.encodeSegment(mailbox, "Mailbox name")}/${this.encodeSegment(id, "Message id")}`,
      { seen: true },
    );
  }

  /**
   * Deletes one message via `DELETE /api/v1/mailbox/{name}/{id}`.
   */
  async deleteMessage(mailbox: string, id: string): Promise<void> {
    await this.apiOk(
      "DELETE",
      `/api/v1/mailbox/${this.encodeSegment(mailbox, "Mailbox name")}/${this.encodeSegment(id, "Message id")}`,
    );
  }

  /**
   * Deletes every message in a mailbox via `DELETE /api/v1/mailbox/{name}`.
   */
  async purgeMailbox(mailbox: string): Promise<void> {
    await this.apiOk("DELETE", `/api/v1/mailbox/${this.encodeSegment(mailbox, "Mailbox name")}`);
  }

  private encodeSegment(value: string, label: string): string {
    if (!value) {
      throw new InbucketError(`${label} is required`, 400, { code: "INVALID_CONFIG" });
    }
    return encodeURIComponent(value);
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
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
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
      throw new InbucketError(
        err instanceof Error ? err.message : "Inbucket API request failed",
        0,
        err,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new InbucketError(
        text || `Inbucket API error (${response.status})`,
        response.status,
        text,
      );
    }

    return response;
  }

  private async apiJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.apiFetch(method, path, body);
    return (await readJsonBody(response, "inbucket")) as T;
  }

  private async apiOk(method: string, path: string, body?: unknown): Promise<void> {
    await this.apiFetch(method, path, body);
  }
}
