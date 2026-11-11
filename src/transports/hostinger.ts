/**
 * @module
 * Hostinger email — Mail API transport (`api.mail.hostinger.com`) plus ready
 * SMTP config for `createSMTPMailer` (`smtp.hostinger.com`, ports 465 / 587).
 *
 * The Mail API sends from the managed mailbox itself, so `MailOptions.from`
 * only contributes the sender display name. Vendor extras (`listMailboxes`,
 * `sendReply`, `sendForward`) stay on this class — never on the channel sender.
 *
 * @example Mail API
 * ```ts
 * import { HostingerTransport } from "sently/transports/hostinger";
 * import { createMailer } from "sently/mailer";
 *
 * const hostinger = new HostingerTransport({
 *   token: process.env.HOSTINGER_API_TOKEN!,
 *   mailbox: process.env.HOSTINGER_MAILBOX_ID!, // e.g. "AC1a2b3c4d5e6f7g"
 * });
 * const mailer = await createMailer({ transport: hostinger });
 *
 * await mailer.send({
 *   from: "you@yourdomain.com",
 *   to: "recipient@example.com",
 *   subject: "Hello",
 *   html: "<p>Sent via Hostinger</p>",
 * });
 * ```
 *
 * @example SMTP — same name, SMTP-shaped config (no `new`)
 * ```ts
 * import { createSMTPMailer } from "sently/smtp";
 * import { HostingerTransport } from "sently/transports/hostinger";
 *
 * const mailer = await createSMTPMailer(
 *   HostingerTransport({
 *     user: "you@yourdomain.com",
 *     pass: process.env.HOSTINGER_SMTP_PASSWORD!,
 *   }),
 * );
 * ```
 */

import { extractEmails, parseAddresses } from "../core/address.js";
import { encodeBase64 } from "../core/base64.js";
import { httpStatusToSentlyCode, SentlyError } from "../core/errors.js";
import { providerFetch } from "../core/http.js";
import type {
  MailOptions,
  SendResult,
  SMTPConfig,
  Transport,
  VerifyResult,
} from "../core/types.js";
import { resolveAttachments } from "./resolve-attachments.js";

/** Hostinger SMTP hostname. */
export const HOSTINGER_SMTP_HOST = "smtp.hostinger.com";

/** SSL/TLS-on-connect submission port (default for {@link HostingerTransport} SMTP). */
export const HOSTINGER_SMTP_PORT_SSL = 465;

/** STARTTLS submission port. */
export const HOSTINGER_SMTP_PORT_STARTTLS = 587;

/** Default Hostinger Mail API base URL. */
export const HOSTINGER_API_BASE_URL = "https://api.mail.hostinger.com";

/** Hostinger Mail API configuration. */
export interface HostingerConfig {
  /** API token from hPanel → Emails → Agentic Mail → API access (shown once at creation). */
  token: string;
  /** Resource ID of the managed mailbox to send from (e.g. `"AC1a2b3c4d5e6f7g"`). */
  mailbox: string;
  /** API base URL. Default: {@link HOSTINGER_API_BASE_URL}. */
  baseUrl?: string;
}

/**
 * Ready SMTP options for Hostinger Email.
 * Pass `HostingerTransport({ user, pass })` to `createSMTPMailer`.
 */
export interface HostingerSmtpOptions {
  /** Full mailbox address — this is the SMTP username. */
  user: string;
  /** Mailbox password from hPanel → Emails → Configuration settings. */
  pass: string;
  /**
   * Submission port.
   * - `465` — SSL/TLS on connect (default)
   * - `587` — STARTTLS
   */
  port?: 465 | 587;
  /** Enable the SMTP connection pool. Default: `false`. */
  pool?: boolean;
  /** Max simultaneous SMTP connections when `pool` is true. Default: `5`. */
  maxConnections?: number;
}

/** A mailbox the API token can manage, as returned by {@link HostingerTransport.listMailboxes}. */
export interface HostingerMailbox {
  /** Mailbox resource ID — pass it as {@link HostingerConfig.mailbox}. */
  resourceId: string;
  /** Email address of the mailbox. */
  address: string;
}

/**
 * Reference to a source message by IMAP UID within a folder.
 * Used by {@link HostingerTransport.sendReply} and {@link HostingerTransport.sendForward}.
 */
export interface HostingerMessageRef {
  /** Folder containing the source message (e.g. `"INBOX"`). */
  folder: string;
  /** IMAP UID of the source message. */
  uid: number;
}

/** Error envelope returned by the Hostinger Mail API on non-success responses. */
interface HostingerErrorEnvelope {
  error?: string;
  code?: string;
  params?: Record<string, unknown>;
}

/** Optional reply / forward threading fields for the Mail API send body. */
interface HostingerSendExtras {
  inReplyTo?: HostingerMessageRef;
  forwardOf?: HostingerMessageRef;
}

/**
 * Build a ready {@link SMTPConfig} for Hostinger Email.
 *
 * Defaults to port `465` with `secure: true`. Hostinger supports `465` and
 * `587` only — not `2525`. Prefer `HostingerTransport({ user, pass })`; this
 * alias stays for 1.x compatibility.
 */
export function hostingerSmtpConfig(options: HostingerSmtpOptions): SMTPConfig {
  const port = options.port ?? HOSTINGER_SMTP_PORT_SSL;
  return {
    host: HOSTINGER_SMTP_HOST,
    port,
    secure: port === HOSTINGER_SMTP_PORT_SSL,
    auth: { user: options.user, pass: options.pass },
    ...(options.pool !== undefined ? { pool: options.pool } : {}),
    ...(options.maxConnections !== undefined ? { maxConnections: options.maxConnections } : {}),
  };
}

/** Error thrown when the Hostinger Mail API returns a non-success response. */
export class HostingerError extends SentlyError {
  /** Creates a Hostinger Mail API error with status code and response payload. */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly apiError: unknown,
  ) {
    super(message, httpStatusToSentlyCode(statusCode), {
      statusCode,
      provider: "hostinger",
      cause: apiError,
    });
    this.name = "HostingerError";
  }
}

/**
 * Hostinger Mail API transport instance type (`new` / call with API config).
 * Constructed by the {@link HostingerTransport} overload — not exported directly.
 */
class HostingerTransportImpl implements Transport {
  readonly provider = "hostinger";

  /** Hostinger Mail API token for Bearer authentication. */
  private readonly token: string;
  /** Resource ID of the managed mailbox to send from. */
  private readonly mailbox: string;
  /** Hostinger Mail API base URL. */
  private readonly baseUrl: string;

  /** Creates a Hostinger transport with the given API token and mailbox. */
  constructor(config: HostingerConfig) {
    this.token = config.token;
    this.mailbox = config.mailbox;
    this.baseUrl = config.baseUrl ?? HOSTINGER_API_BASE_URL;
  }

  /** List the mailboxes this token can manage — use it to discover your mailbox resource ID. */
  async listMailboxes(): Promise<HostingerMailbox[]> {
    const response = await providerFetch(`${this.baseUrl}/api/v1/me`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    const payload = (await response.json().catch(() => ({}))) as {
      data?: { mailboxes?: HostingerMailbox[] };
    } & HostingerErrorEnvelope;

    if (!response.ok) {
      throw new HostingerError(
        payload.error ?? `Hostinger API error (HTTP ${response.status})`,
        response.status,
        payload,
      );
    }

    return payload.data?.mailboxes ?? [];
  }

  /** Build the JSON body for a single Hostinger email. */
  private async buildEmailBody(
    options: MailOptions,
    extras?: HostingerSendExtras,
  ): Promise<Record<string, unknown>> {
    if (extras?.inReplyTo && extras.forwardOf) {
      throw new HostingerError("inReplyTo and forwardOf are mutually exclusive", 422, {
        code: "MUTUALLY_EXCLUSIVE",
        params: { inReplyTo: ["conflicts with forwardOf"] },
      });
    }

    const attachments = await resolveAttachments(options.attachments);
    const from = parseAddresses(options.from)[0];
    return {
      to: extractEmails(options.to),
      ...(from?.name ? { displayName: from.name } : {}),
      ...(options.cc ? { cc: extractEmails(options.cc) } : {}),
      ...(options.bcc ? { bcc: extractEmails(options.bcc) } : {}),
      subject: options.subject,
      ...(options.text ? { text: options.text } : {}),
      ...(options.html ? { html: options.html } : {}),
      ...(attachments.length > 0
        ? {
            attachments: attachments.map((att) => ({
              filename: att.filename,
              content:
                att.content instanceof Uint8Array || typeof att.content === "string"
                  ? encodeBase64(att.content).replace(/\r\n/g, "")
                  : "",
              ...(att.contentType ? { contentType: att.contentType } : {}),
              ...(att.contentId ? { cid: att.contentId.replace(/^<|>$/g, "") } : {}),
            })),
          }
        : {}),
      ...(extras?.inReplyTo ? { inReplyTo: extras.inReplyTo } : {}),
      ...(extras?.forwardOf ? { forwardOf: extras.forwardOf } : {}),
    };
  }

  /** Map a 204 No Content success to a normalized SendResult. */
  private toSendResult(options: MailOptions): SendResult {
    const from = parseAddresses(options.from)[0];
    return {
      messageId: options.messageId ?? "",
      accepted: extractEmails(options.to),
      rejected: [],
      response: "Message sent and saved to the Sent folder",
      envelope: {
        from: from?.address ?? "",
        to: [
          ...extractEmails(options.to),
          ...(options.cc ? extractEmails(options.cc) : []),
          ...(options.bcc ? extractEmails(options.bcc) : []),
        ],
      },
    };
  }

  /** POST the send body and map the response. */
  private async postSend(options: MailOptions, extras?: HostingerSendExtras): Promise<SendResult> {
    const body = await this.buildEmailBody(options, extras);

    const response = await providerFetch(
      `${this.baseUrl}/api/v1/mailboxes/${encodeURIComponent(this.mailbox)}/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    if (response.ok) {
      return this.toSendResult(options);
    }

    const payload = (await response.json().catch(() => ({}))) as HostingerErrorEnvelope;
    throw new HostingerError(
      payload.error ?? `Hostinger API error (HTTP ${response.status})`,
      response.status,
      payload,
    );
  }

  /** Sends an email via the Hostinger Mail API. */
  async send(options: MailOptions): Promise<SendResult> {
    return this.postSend(options);
  }

  /**
   * Reply to a mailbox message.
   * Copies Message-Id / References into In-Reply-To / References and flags the
   * source `\Answered`. Mutually exclusive with {@link sendForward}.
   */
  async sendReply(options: MailOptions, inReplyTo: HostingerMessageRef): Promise<SendResult> {
    return this.postSend(options, { inReplyTo });
  }

  /**
   * Forward a mailbox message.
   * Copies Message-Id / References into In-Reply-To / References and flags the
   * source `$forwarded`. Mutually exclusive with {@link sendReply}.
   */
  async sendForward(options: MailOptions, forwardOf: HostingerMessageRef): Promise<SendResult> {
    return this.postSend(options, { forwardOf });
  }

  /** Verifies the API token and that the configured mailbox is in its scope. */
  async verify(): Promise<VerifyResult> {
    try {
      const mailboxes = await this.listMailboxes();
      const configured = mailboxes.find((mailbox) => mailbox.resourceId === this.mailbox);

      if (!configured) {
        return {
          ok: false,
          provider: "hostinger",
          message: `Mailbox "${this.mailbox}" is not in this token's scope`,
          raw: mailboxes,
        };
      }

      return {
        ok: true,
        provider: "hostinger",
        message: `API token is valid — sending as ${configured.address}`,
        raw: mailboxes,
      };
    } catch (err) {
      if (err instanceof HostingerError) {
        return { ok: false, provider: "hostinger", message: err.message };
      }
      return {
        ok: false,
        provider: "hostinger",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Hostinger Mail API transport instance (returned by {@link HostingerTransport}
 * overloads for `{ token, mailbox }` config).
 */
export type HostingerMailTransport = HostingerTransportImpl;

/**
 * Function-overloaded constructor for `HostingerTransport`:
 * - `new` / call with {@link HostingerConfig} → {@link HostingerMailTransport}
 * - call with {@link HostingerSmtpOptions} → {@link SMTPConfig}
 */
export interface HostingerTransportOverloads {
  new (config: HostingerConfig): HostingerMailTransport;
  (config: HostingerConfig): HostingerMailTransport;
  (config: HostingerSmtpOptions): SMTPConfig;
}

/**
 * Hostinger email — one name, two shapes (function overloading).
 *
 * - **Mail API** — `new HostingerTransport({ token, mailbox })` (or the same
 *   call without `new`) → a `Transport` for `createMailer`.
 * - **SMTP** — `HostingerTransport({ user, pass })` → a ready `SMTPConfig`
 *   for `createSMTPMailer`.
 *
 * IntelliSense narrows options and the return type by the config shape.
 */
export const HostingerTransport = function (
  this: HostingerTransportImpl | undefined,
  config: HostingerConfig | HostingerSmtpOptions,
) {
  if ("token" in config) {
    return new HostingerTransportImpl(config);
  }
  return hostingerSmtpConfig(config);
} as unknown as HostingerTransportOverloads;
