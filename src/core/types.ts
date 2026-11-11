// src/core/types.ts

// ─── Address ──────────────────────────────────────────────

/** A single email address with optional display name. */
export interface Address {
  /** Optional display name shown before the email address. */
  name?: string;
  /** Email address (RFC 5322 addr-spec). */
  address: string;
}

/** Flexible address input accepted by mail APIs. */
export type AddressInput = string | Address | (string | Address)[];

// ─── Attachment ───────────────────────────────────────────

/** Email attachment (in-memory or file path on supported runtimes). */
export interface Attachment {
  /** Filename shown to the recipient. */
  filename: string;
  /** In-memory attachment body as bytes or string. */
  content?: Uint8Array | string;
  /** Filesystem path to read attachment from (Node.js / Bun only). */
  path?: string;
  /** MIME content type. Defaults to `application/octet-stream`. */
  contentType?: string;
  /** Content transfer encoding for the attachment part. */
  encoding?: "base64" | "7bit" | "8bit" | "binary" | "quoted-printable";
  /** Content-ID for inline images referenced from HTML (`cid:` URLs). */
  contentId?: string;
  /** When true, disposition is `inline` instead of `attachment`. */
  inline?: boolean;
  /** Extra MIME headers for this attachment part. */
  headers?: Record<string, string>;
}

// ─── Mail Options ─────────────────────────────────────────

/** Options for composing and sending an email message. */
export interface MailOptions {
  /** Sender address. */
  from: AddressInput;
  /** Primary recipient(s). */
  to: AddressInput;
  /** Carbon-copy recipient(s). */
  cc?: AddressInput;
  /** Blind carbon-copy recipient(s). */
  bcc?: AddressInput;
  /** Address used for replies (Reply-To header). */
  replyTo?: AddressInput;
  /** Message subject line. */
  subject: string;
  /** Plain-text body. */
  text?: string;
  /** HTML body. */
  html?: string;
  /** File or in-memory attachments. */
  attachments?: Attachment[];
  /** Additional MIME headers merged into the message. */
  headers?: Record<string, string>;
  /** Explicit Message-ID header value. */
  messageId?: string;
  /** Date header value. Defaults to send time. */
  date?: Date;
  /** Message priority hint for the Priority header. */
  priority?: "high" | "normal" | "low";
  /** Character set for text parts. */
  encoding?: "utf-8" | "ascii";
  /** Template name registered with templatePlugin */
  template?: string;
  /** Template variables passed to the rendering engine */
  data?: Record<string, unknown>;
  /**
   * React element rendered to html + text by the sently/react plugin.
   * Requires `@react-email/render`.
   */
  react?: unknown;
  /**
   * Idempotency key for deduplicating sends on retry or replay.
   * When absent but `messageId` is set, transports derive a stable key from it.
   */
  idempotencyKey?: string;
}

// ─── Send Result ──────────────────────────────────────────

/** Result returned after a message is accepted for delivery. */
export interface SendResult {
  /** Assigned or generated Message-ID. */
  messageId: string;
  /** Envelope recipients accepted by the server. */
  accepted: string[];
  /** Envelope recipients rejected by the server. */
  rejected: string[];
  /** Raw server response text (SMTP or HTTP). */
  response: string;
  /** SMTP envelope used for delivery. */
  envelope: Envelope;
  /** When true, the send was skipped because an idempotency key was already recorded. */
  deduped?: boolean;
  /** Set when this item failed inside an otherwise successful batch HTTP response. */
  batchError?: unknown;
  /** Identifier of the transport that handled the send; set by FallbackTransport. */
  provider?: string;
  /**
   * Zero-based index of the transport that handled the send in a fallback chain.
   * Set by FallbackTransport (e.g. `1` means provider #0 failed and #1 succeeded).
   */
  providerIndex?: number;
}

// ─── Envelope ─────────────────────────────────────────────

/** SMTP envelope addresses (MAIL FROM / RCPT TO). */
export interface Envelope {
  /** Envelope sender (MAIL FROM). */
  from: string;
  /** Envelope recipients (RCPT TO). */
  to: string[];
}

// ─── Socket Adapter ───────────────────────────────────────

/** Runtime-specific TCP/TLS socket abstraction for SMTP. */
export interface SocketAdapter {
  /** Connect to the SMTP host on the given port. */
  connect(host: string, port: number): Promise<void>;
  /** Upgrade the connection to TLS (STARTTLS). */
  startTLS(options?: TLSOptions): Promise<void>;
  /** Write raw bytes to the socket. */
  write(data: Uint8Array): Promise<void>;
  /** Async iterator of bytes read from the socket. */
  read(): AsyncIterable<Uint8Array>;
  /** Close the connection. */
  close(): Promise<void>;
  /** Abort the socket so an in-flight read or write settles. */
  destroy?(): Promise<void>;
  /** Drop bytes already received but not yet consumed. */
  discardBuffered?(): void;
  /** Detach plaintext reads before STARTTLS so the TLS stack owns the socket. */
  prepareStartTls?(): void;
  /** Whether the connection is currently encrypted. */
  readonly secure: boolean;
  /** Whether the socket is connected. */
  readonly connected: boolean;
}

// ─── TLS Options ──────────────────────────────────────────

/** TLS connection options for STARTTLS and direct TLS. */
export interface TLSOptions {
  /** Verify server certificate. Default: true. */
  rejectUnauthorized?: boolean;
  /** SNI server name for certificate validation. */
  servername?: string;
  /** Minimum TLS version. Useful for legacy SMTP servers still on TLS 1.1. */
  minVersion?: "TLSv1" | "TLSv1.1" | "TLSv1.2" | "TLSv1.3";
}

// ─── Verify Result ────────────────────────────────────────

/** Result returned by transport and mailer verify() calls. */
export interface VerifyResult {
  /** Whether connectivity and authentication succeeded. */
  ok: boolean;
  /** Transport or provider identifier (e.g. `"smtp"`, `"resend"`). */
  provider: string;
  /** Human-readable status message from the provider */
  message?: string;
  /** Raw provider response (provider-specific) */
  raw?: unknown;
}

// ─── Transport ────────────────────────────────────────────

/** Pluggable mail delivery backend (SMTP, HTTP API, etc.). */
export interface Transport {
  /**
   * Stable provider identifier for observability (e.g. `"resend"`, `"ses"`).
   * Prefer this over constructor-name inference in hooks and fallback diagnostics.
   */
  readonly provider?: string;
  /** Send a message through this transport. */
  send(options: MailOptions): Promise<SendResult>;
  /**
   * Send multiple messages in one provider batch request when supported.
   * Messages with attachments may be excluded by the mailer and sent individually.
   */
  sendBatch?(messages: MailOptions[]): Promise<SendResult[]>;
  /**
   * When set, {@link Mailer.sendBulk} splits batch sends into chunks of this size.
   * Omit when the transport sends all messages in one HTTP request (e.g. SendGrid).
   */
  batchMax?: number;
  /** Test connectivity and credentials without sending mail. */
  verify?(): Promise<VerifyResult>;
  /** Release resources held by the transport. */
  close?(): Promise<void>;
}

// ─── DKIM ─────────────────────────────────────────────────

/** DKIM signing configuration for outbound messages. */
export interface DKIMConfig {
  /** Your domain name. e.g. "example.com" */
  domainName: string;
  /** Key selector. e.g. "2024" → looks up 2024._domainkey.example.com */
  keySelector: string;
  /**
   * DKIM private key in PEM format.
   * Supports RSA (minimum 1024-bit, 2048 recommended) and Ed25519.
   */
  privateKey: string;
  /** Algorithm. Default: "rsa-sha256". Use "ed25519-sha256" for Ed25519 keys. */
  algorithm?: "rsa-sha256" | "ed25519-sha256";
  /**
   * Header fields to sign (colon-separated).
   * Default follows RFC 6376 §5.4 recommendations.
   */
  headerFieldNames?: string;
  /**
   * Skip signing these header fields even if listed in headerFieldNames.
   * Useful to exclude "message-id" and "date" for privacy.
   */
  skipFields?: string;
}

// ─── OAuth2 ───────────────────────────────────────────────

/** OAuth2 credentials for XOAUTH2 SMTP authentication. */
export interface OAuth2Config {
  /** The authenticated user's email address */
  user: string;
  /** OAuth2 client ID */
  clientId: string;
  /** OAuth2 client secret */
  clientSecret: string;
  /** Refresh token for automatic access token renewal */
  refreshToken: string;
  /** Current access token (optional — will be fetched if absent) */
  accessToken?: string;
  /** Token endpoint URL. Default: Google's token endpoint */
  tokenUrl?: string;
  /**
   * Custom token provider function.
   * If provided, clientId / clientSecret / refreshToken are ignored.
   * The function must return a valid access token string.
   */
  getToken?: () => Promise<string>;
}

// ─── Pool Config ──────────────────────────────────────────

/** Connection pool and rate limiting options for SMTP. */
export interface PoolConfig {
  /** Use connection pooling. Default: false */
  pool?: boolean;
  /** Maximum number of simultaneous SMTP connections. Default: 5 */
  maxConnections?: number;
  /**
   * Maximum number of messages per connection before it is recycled.
   * Default: 100
   */
  maxMessages?: number;
  /**
   * Maximum send rate in messages per second across all connections.
   * Default: unlimited
   */
  rateDelta?: number;
  /**
   * The time window in milliseconds for rate limiting.
   * Default: 1000 (1 second)
   */
  rateLimit?: number;
}

// ─── SMTP Config ──────────────────────────────────────────

/** Configuration for SMTP transport and relay connections. */
export interface SMTPConfig extends PoolConfig {
  /** SMTP server hostname or IP address. */
  host: string;
  /** SMTP port. Defaults to 587 (STARTTLS) or 465 (direct TLS). */
  port?: number;
  /** Use implicit TLS on connect (typically port 465). */
  secure?: boolean;
  /** SMTP authentication credentials. */
  auth?: SMTPAuth;
  /**
   * Refuse to authenticate over a non-TLS connection.
   * When true, throws SMTPError before sending AUTH if the connection
   * is not encrypted. Prevents credential exposure on STARTTLS-stripping
   * MITM attacks. Default: true when auth is set, false otherwise.
   */
  requireTLS?: boolean;
  /**
   * STARTTLS policy for a cleartext connection.
   * `opportunistic` (default) upgrades when the server advertises STARTTLS.
   * `required` fails before AUTH or MAIL if the upgrade is unavailable.
   * `never` does not send STARTTLS even when it is advertised.
   * Implicit TLS (`secure: true`) is already encrypted and skips STARTTLS.
   */
  starttls?: "required" | "opportunistic" | "never";
  /** TLS options for STARTTLS and direct TLS connections. */
  tls?: TLSOptions;
  /**
   * Name sent in EHLO. Default: the OS hostname, or `[127.0.0.1]` when no
   * hostname is available. This is the client identity, not the server host.
   */
  clientName?: string;
  /** Socket connect timeout in milliseconds. */
  connectionTimeout?: number;
  /**
   * Timeout waiting for the SMTP greeting in milliseconds.
   * Default: `connectionTimeout` when set, otherwise 30 seconds. `0` disables.
   */
  greetingTimeout?: number;
  /**
   * Per-reply and per-write deadline in milliseconds.
   * Default: `connectionTimeout` when set, otherwise 60 seconds. `0` disables.
   */
  socketTimeout?: number;
  /**
   * Optional deadline for one SMTP send in milliseconds, including a pooled send.
   * It starts when that send begins, not while it waits for a free connection.
   * `0` disables. Command deadlines still apply when this is omitted.
   */
  sendTimeout?: number;
  /**
   * When set, `attachment.path` must resolve inside this directory.
   * Symlinks that point outside it are rejected. Without this option,
   * `path` is trusted local I/O.
   */
  attachmentBasePath?: string;
  /** Deliver directly to recipient MX (no relay). Requires adapter support. */
  direct?: boolean;
  /** Runtime socket adapter for TCP/TLS I/O. */
  adapter?: SocketAdapter;
  /** Optional DKIM signing applied to outbound MIME. */
  dkim?: DKIMConfig;
  /** Plugins run sequentially before message construction. */
  plugins?: MailPlugin[];
}

/** SMTP authentication credentials and method hint. */
export interface SMTPAuth {
  /** SMTP username (often the email address). */
  user: string;
  /** Password for LOGIN, PLAIN, or CRAM-MD5 authentication. */
  pass?: string;
  /** Preferred AUTH mechanism. Auto-selected from server capabilities when omitted. */
  type?: "LOGIN" | "PLAIN" | "CRAM-MD5" | "OAUTH2";
  /** OAuth2 configuration for XOAUTH2 authentication. */
  oauth2?: OAuth2Config;
}

// ─── Mailer ───────────────────────────────────────────────

/** High-level mailer API wrapping a transport. */
export interface Mailer {
  /** Send a single email message. */
  send(options: MailOptions): Promise<SendResult>;
  /** Send multiple messages with optional concurrency limits. */
  sendBulk(messages: MailOptions[], options?: BulkSendOptions): Promise<BulkSendResult>;
  /** Verify transport connectivity and credentials. */
  verify(): Promise<VerifyResult>;
  /** Close the underlying transport and release resources. */
  close(): Promise<void>;
}

// ─── Bulk Send ────────────────────────────────────────────

/** Options for batch sending multiple messages. */
export interface BulkSendOptions {
  /** Callback fired after each successful send */
  onSuccess?: (message: MailOptions, index: number, result: SendResult) => void;
  /** Callback fired after each failed send (does not throw) */
  onError?: (message: MailOptions, index: number, error: unknown) => void;
  /** Max concurrent sends. Defaults to 1. */
  concurrency?: number;
  /** When true, stop sending after the first failure. Default: false */
  stopOnError?: boolean;
  /**
   * Max batch HTTP requests per rate window (e.g. Resend default 2 req/s).
   * Set to `0` to disable batch rate limiting. Default: `2`.
   */
  rateDelta?: number;
  /** Rate limit window in milliseconds. Default: `1000`. */
  rateLimit?: number;
  /** Injectable clock for batch rate limiting (testing). */
  now?: () => number;
}

/** Result of a batch send operation. */
export interface BulkSendResult {
  /** Total messages attempted */
  total: number;
  /** Number of successful sends */
  sent: number;
  /** Number of failed sends */
  failed: number;
  /** Per-message results in input order */
  results: Array<{ status: "sent"; result: SendResult } | { status: "failed"; error: unknown }>;
}

// ─── Retry Config ─────────────────────────────────────────

/** Configuration for RetryTransport backoff and retry rules. */
export interface RetryConfig {
  /** Maximum number of total attempts (including first). Default: 3 */
  maxAttempts?: number;
  /** Backoff strategy. Default: 'exponential' */
  backoff?: "exponential" | "linear" | "fixed";
  /** Base delay in ms. Default: 1000 */
  baseDelay?: number;
  /** Maximum delay for one backoff sleep in ms. Default: 60000 */
  maxDelay?: number;
  /**
   * HTTP status codes to retry on (for HTTP transports).
   * Default: [429, 500, 502, 503, 504]
   */
  retryOn?: number[];
  /** Optional callback called before each retry */
  onRetry?: (attempt: number, error: unknown) => void;
}

// ─── Preview Config ───────────────────────────────────────

/** Configuration for PreviewTransport disk output. */
export interface PreviewConfig {
  /**
   * Directory to write .eml files.
   * Default: './.emails'
   */
  outDir?: string;
  /**
   * Open the email in the default browser after writing.
   * Uses 'open' on macOS, 'xdg-open' on Linux, 'start' on Windows.
   * Default: false
   */
  open?: boolean;
  /**
   * File format to write.
   * 'eml' = raw MIME, 'html' = HTML body only (for quick preview)
   * Default: 'eml'
   */
  format?: "eml" | "html";
}

// ─── Mailer Hooks ─────────────────────────────────────────

/** Context passed to mailer lifecycle hooks (no message body — avoids PII in logs). */
export interface MailerHookContext {
  /** Message-ID when known (from options or send result). */
  messageId?: string;
  /** Envelope recipient email addresses. */
  to: string[];
  /** Message subject line. */
  subject: string;
  /** Transport or provider identifier (e.g. `"smtp"`, `"resend"`). */
  provider: string;
}

/** Optional lifecycle hooks for metrics, tracing, and observability on every send. */
export interface MailerHooks {
  /** Fired before the transport sends the message. */
  onSend?: (ctx: MailerHookContext) => void | Promise<void>;
  /**
   * Fired after a successful send.
   * @param durationMs — elapsed milliseconds from send start to success (optional third argument).
   */
  onSuccess?: (
    ctx: MailerHookContext,
    result: SendResult,
    durationMs?: number,
  ) => void | Promise<void>;
  /**
   * Fired when a send throws (error is re-thrown after the hook runs).
   * @param durationMs — elapsed milliseconds from send start to failure (optional third argument).
   */
  onError?: (ctx: MailerHookContext, error: unknown, durationMs?: number) => void | Promise<void>;
  /** Fired before each retry attempt (requires {@link RetryTransport}). */
  onRetry?: (ctx: MailerHookContext, attempt: number, error: unknown) => void | Promise<void>;
  /**
   * Fired when {@link FallbackTransport} fails over to the next provider.
   * Requires a {@link FallbackTransport} (or {@link WeightedFallbackTransport}) in the mailer stack.
   */
  onFallback?: (
    ctx: MailerHookContext,
    failedProvider: string,
    nextProvider: string,
    error: unknown,
  ) => void | Promise<void>;
}

// ─── createMailer Options ─────────────────────────────────

/** Options for {@link createMailer} from `sently/mailer` — transport-only, smallest bundle. */
export interface TransportMailerOptions {
  /** Transport that sends the message (HTTP API, SMTP wrapper, preview, etc.). */
  transport: Transport;
  /** Optional plugins run before each send. */
  plugins?: MailPlugin[];
  /** Optional lifecycle hooks for metrics and tracing on every send. */
  hooks?: MailerHooks;
}

/** Options for {@link createSMTPMailer} from `sently/smtp` or the main barrel. */
export type SMTPMailerOptions = SMTPConfig & { hooks?: MailerHooks };

// ─── Plugin ──────────────────────────────────────────────

/**
 * A mail plugin transforms MailOptions before the message is built.
 * Plugins run sequentially. Each receives the output of the previous.
 * Return a new MailOptions object — do not mutate the input.
 *
 * @example
 * ```ts
 * const addFooter = (options: MailOptions): MailOptions => ({
 *   ...options,
 *   html: options.html + '<p>Unsubscribe</p>',
 * })
 * ```
 */
export type MailPlugin =
  | ((options: MailOptions) => MailOptions)
  | ((options: MailOptions) => Promise<MailOptions>);

// ─── Mailgun Config ───────────────────────────────────────

/** Mailgun HTTP API configuration. */
export interface MailgunConfig {
  /** Mailgun API key (starts with "key-") */
  apiKey: string;
  /** Your Mailgun sending domain (e.g. "mg.example.com") */
  domain: string;
  /** API region. Default: 'us' (api.mailgun.net). Use 'eu' for api.eu.mailgun.net */
  region?: "us" | "eu";
}

// ─── AWS SES Config ───────────────────────────────────────

/** AWS SES v2 HTTP API configuration. */
export interface SESConfig {
  /** AWS Access Key ID */
  accessKeyId: string;
  /** AWS Secret Access Key */
  secretAccessKey: string;
  /** AWS Region. Default: 'us-east-1' */
  region?: string;
  /** Optional session token for temporary credentials */
  sessionToken?: string;
  /** DKIM signing for raw MIME messages (attachment sends) */
  dkim?: DKIMConfig;
}

// ─── Brevo Config ─────────────────────────────────────────

/** Brevo (formerly Sendinblue) HTTP API configuration. */
export interface BrevoConfig {
  /** Brevo (formerly Sendinblue) API key */
  apiKey: string;
}

// ─── Runtime ──────────────────────────────────────────────

/** Detected JavaScript runtime environment. */
export type Runtime = "node" | "bun" | "deno" | "cf-workers" | "browser" | "unknown";
