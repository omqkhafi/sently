/**
 * @module
 * SMTP transport — orchestrates socket adapter, MIME builder, and protocol logic.
 *
 * @example
 * ```ts
 * import { SMTPTransport } from "sently/transports/smtp";
 * import { NodeAdapter } from "sently/adapters/node";
 * import { createMailer } from "sently/mailer";
 *
 * const mailer = await createMailer({
 *   transport: new SMTPTransport({
 *     host: "smtp.example.com",
 *     auth: { user: "you@example.com", pass: "secret" },
 *     adapter: new NodeAdapter(),
 *   }),
 * });
 * ```
 */
import { OAuth2Client } from "../auth/oauth2.js";
import { parseAddresses } from "../core/address.js";
import { SentlyError } from "../core/errors.js";
import { buildMIME, type MIMEBuildResult } from "../core/mime.js";
import type { SMTPResponse } from "../core/smtp.js";
import {
  assertResponse,
  computeCRAMMD5,
  encodeAuthLoginPass,
  encodeAuthLoginUser,
  encodeCommand,
  encodeLine,
  parseEHLO,
  parseResponse,
  SMTPError,
  selectAuthMethod,
  splitSmtpReply,
} from "../core/smtp.js";
import { tlsServerName } from "../core/tls-name.js";
import type {
  MailOptions,
  SendResult,
  SMTPConfig,
  SocketAdapter,
  Transport,
  VerifyResult,
} from "../core/types.js";
import { resolveAttachments } from "./resolve-attachments.js";

/** Default wait for the SMTP greeting when neither greeting nor connection timeout is set. */
const DEFAULT_GREETING_TIMEOUT_MS = 30_000;
/** Default per-reply and per-write deadline when neither socket nor connection timeout is set. */
const DEFAULT_SOCKET_TIMEOUT_MS = 60_000;

/**
 * SMTP transport orchestrating adapter, MIME builder, and protocol logic.
 */
export class SMTPTransport implements Transport {
  readonly provider = "smtp";

  /** Resolved SMTP configuration with defaults applied. */
  private readonly config: ResolvedSMTPConfig;
  /** Active socket adapter for the current session, if any. */
  private adapter: SocketAdapter | null = null;
  /** Serializes send() so one adapter is never used by two messages at once. */
  private sendChain: Promise<void> = Promise.resolve();

  /** Creates an SMTP transport with the given configuration. */
  constructor(config: SMTPConfig) {
    this.config = resolveSMTPConfig(config);
  }

  /**
   * Sends an email via SMTP using the configured adapter.
   * Concurrent calls on the same transport run one after another. Each send
   * opens and closes its own SMTP session on that adapter.
   */
  async send(options: MailOptions): Promise<SendResult> {
    const run = (): Promise<SendResult> => this.sendExclusive(options);
    const result = this.sendChain.then(run, run);
    this.sendChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** One send, with the transport lock already held. */
  private async sendExclusive(options: MailOptions): Promise<SendResult> {
    const work = async (): Promise<SendResult> => {
      const resolvedOptions = {
        ...options,
        attachments: await resolveAttachments(options.attachments, {
          ...(this.config.attachmentBasePath !== undefined
            ? { basePath: this.config.attachmentBasePath }
            : {}),
        }),
      };
      const adapter = await this.getAdapter();

      const fromAddress = parseAddresses(options.from)[0]?.address ?? this.config.host;
      const host = this.config.direct
        ? await resolveMX(fromAddress.split("@")[1] ?? this.config.host)
        : this.config.host;

      await adapter.connect(host, this.config.port);
      this.adapter = adapter;

      try {
        const capabilities = await openSMTPSession(adapter, this.config);
        const mime = await buildMIME(resolvedOptions, this.config.dkim, {
          allow8BitMime: capabilities.some((cap) => cap.toUpperCase() === "8BITMIME"),
        });
        return await deliverSMTPMessage(adapter, mime);
      } finally {
        await closeSMTPSession(adapter);
        this.adapter = null;
      }
    };

    const sendTimeout = this.config.sendTimeout;
    if (sendTimeout === undefined || sendTimeout <= 0) {
      return work();
    }
    return withDeadline(work(), sendTimeout, "SMTP send timed out", async () => {
      await this.adapter?.destroy?.();
    });
  }

  /** Verifies SMTP connectivity and authentication without sending mail. */
  async verify(): Promise<VerifyResult> {
    try {
      const adapter = await this.getAdapter();
      await adapter.connect(this.config.host, this.config.port);

      try {
        await openSMTPSession(adapter, this.config);
        return { ok: true, provider: "smtp" };
      } finally {
        await closeSMTPSession(adapter);
      }
    } catch (err) {
      return {
        ok: false,
        provider: "smtp",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Closes the underlying socket adapter if connected. */
  async close(): Promise<void> {
    if (this.adapter) {
      await this.adapter.close();
      this.adapter = null;
    }
  }

  /** Returns the configured socket adapter or throws if none is set. */
  private async getAdapter(): Promise<SocketAdapter> {
    if (!this.config.adapter) {
      throw new SMTPError("No socket adapter configured", 0, "CONNECT", "");
    }
    return this.config.adapter;
  }
}

/** Resolved SMTP transport configuration with defaults applied. */
export interface ResolvedSMTPConfig {
  /** SMTP server hostname. */
  host: string;
  /** SMTP port with secure/default applied. */
  port: number;
  /** Whether implicit TLS is used. */
  secure: boolean;
  /** Resolved authentication credentials, if any. */
  auth?: SMTPConfig["auth"];
  /** Whether AUTH requires an encrypted connection. */
  requireTLS?: boolean;
  /** STARTTLS policy. Default when omitted: opportunistic. */
  starttls?: SMTPConfig["starttls"];
  /** EHLO client name. Default is applied at session open. */
  clientName?: string;
  /** Optional whole-send deadline in milliseconds. */
  sendTimeout?: number;
  /** Directory that attachment paths must stay inside. */
  attachmentBasePath?: string;
  /** TLS options for STARTTLS and direct TLS. */
  tls?: SMTPConfig["tls"];
  /** DKIM signing configuration. */
  dkim?: SMTPConfig["dkim"];
  /** Socket connect timeout in milliseconds. */
  connectionTimeout?: number;
  /** Timeout waiting for the SMTP greeting in milliseconds. */
  greetingTimeout?: number;
  /** Idle socket timeout in milliseconds. */
  socketTimeout?: number;
  /** Direct-to-MX delivery mode. */
  direct?: boolean;
  /** Runtime socket adapter. */
  adapter?: SocketAdapter;
}

/** Apply defaults to SMTP configuration. */
export function resolveSMTPConfig(config: SMTPConfig): ResolvedSMTPConfig {
  const secure = config.secure ?? false;
  return {
    host: config.host,
    port: config.port ?? (secure ? 465 : 587),
    secure,
    ...(config.auth !== undefined ? { auth: config.auth } : {}),
    ...(config.requireTLS !== undefined ? { requireTLS: config.requireTLS } : {}),
    ...(config.starttls !== undefined ? { starttls: config.starttls } : {}),
    ...(config.clientName !== undefined ? { clientName: config.clientName } : {}),
    ...(config.sendTimeout !== undefined ? { sendTimeout: config.sendTimeout } : {}),
    ...(config.attachmentBasePath !== undefined
      ? { attachmentBasePath: config.attachmentBasePath }
      : {}),
    ...(config.dkim !== undefined ? { dkim: config.dkim } : {}),
    ...(config.tls !== undefined ? { tls: config.tls } : {}),
    ...(config.connectionTimeout !== undefined
      ? { connectionTimeout: config.connectionTimeout }
      : {}),
    ...(config.greetingTimeout !== undefined ? { greetingTimeout: config.greetingTimeout } : {}),
    ...(config.socketTimeout !== undefined ? { socketTimeout: config.socketTimeout } : {}),
    ...(config.direct !== undefined ? { direct: config.direct } : {}),
    ...(config.adapter !== undefined ? { adapter: config.adapter } : {}),
  };
}

/**
 * Connect greeting, EHLO, optional STARTTLS, and AUTH on an open adapter.
 *
 * @returns EHLO capability tokens from the final (post-TLS) greeting
 */
export async function openSMTPSession(
  adapter: SocketAdapter,
  config: ResolvedSMTPConfig,
): Promise<string[]> {
  const session = sessionFor(adapter, config);
  const greeting = await session.readResponse(true);
  assertResponse(greeting, [220], "greeting");

  const clientName = config.clientName ?? (await defaultClientName());
  let capabilities = await ehlo(session, clientName);
  const supportsStartTls = capabilities.some((cap) => cap.toUpperCase() === "STARTTLS");
  const encrypted = adapter.secure || config.secure === true;
  const policy = config.starttls ?? "opportunistic";

  if (!encrypted && policy !== "never" && supportsStartTls) {
    try {
      await session.write(encodeCommand({ type: "STARTTLS" }));
      const starttlsResp = await session.readResponse(false);
      assertResponse(starttlsResp, [220], "STARTTLS");
      session.discardPending();
      adapter.discardBuffered?.();
      adapter.prepareStartTls?.();
      const servername = tlsServerName(config.host, config.tls?.servername);
      const upgrade = adapter.startTLS({
        ...config.tls,
        ...(servername !== undefined ? { servername } : {}),
      });
      try {
        await withDeadline(upgrade, session.deadlines.socketMs, "TLS handshake timed out", () => {
          void adapter.destroy?.();
        });
      } catch (error) {
        void upgrade.catch(() => undefined);
        throw error;
      }
      capabilities = await ehlo(session, clientName);
    } catch (error) {
      throw error instanceof SentlyError
        ? error
        : new SentlyError("STARTTLS failed", "TLS_FAILED", { provider: "smtp", cause: error });
    }
  } else if (!encrypted && policy === "required") {
    throw new SentlyError("STARTTLS is required but the server did not offer it", "TLS_FAILED", {
      provider: "smtp",
    });
  }

  if (config.auth) {
    const tlsRequired = config.requireTLS ?? true;
    const nowEncrypted = adapter.secure || config.secure === true;
    if (tlsRequired && !nowEncrypted) {
      throw new SMTPError(
        "Refusing to authenticate over unencrypted connection. " +
          "Set requireTLS: false to disable this check (not recommended).",
        0,
        "AUTH",
        "",
      );
    }
    await authenticate(session, config.auth, capabilities);
  }

  return capabilities;
}

/**
 * MAIL FROM, RCPT TO, and DATA for a built MIME message on an authenticated session.
 */
export async function deliverSMTPMessage(
  adapter: SocketAdapter,
  mime: MIMEBuildResult,
): Promise<SendResult> {
  const session = sessionFor(adapter);
  await session.write(
    encodeCommand({
      type: "MAIL_FROM",
      address: mime.envelope.from,
      ...(mime.eightBit ? { eightBit: true } : {}),
    }),
  );
  const mailResp = await session.readResponse(false);
  assertResponse(mailResp, [250], "MAIL FROM");

  const accepted: string[] = [];
  const rejected: string[] = [];
  let firstReject: SMTPResponse | undefined;

  for (const recipient of mime.envelope.to) {
    await session.write(encodeCommand({ type: "RCPT_TO", address: recipient }));
    const rcptResp = await session.readResponse(false);
    if (rcptResp.isSuccess) {
      accepted.push(recipient);
    } else {
      rejected.push(recipient);
      if (firstReject === undefined) {
        firstReject = rcptResp;
      }
    }
  }

  if (accepted.length === 0) {
    await session.resetOrClose();
    throw new SMTPError(
      "All recipients were rejected",
      firstReject?.code ?? 550,
      "RCPT TO",
      firstReject?.message ?? "",
    );
  }

  await session.write(encodeCommand({ type: "DATA" }));
  const dataResp = await session.readResponse(false);
  assertResponse(dataResp, [354], "DATA");

  let finalResp: SMTPResponse;
  try {
    await session.write(encodeCommand({ type: "DATA_BODY", content: mime.raw }));
    finalResp = await session.readResponse(false);
  } catch (error) {
    await session.resetOrClose();
    throw error;
  }
  assertResponse(finalResp, [250], "DATA end");

  if (rejected.length > 0) {
    await session.resetOrClose();
  }

  return {
    messageId: mime.messageId,
    accepted,
    rejected,
    response: finalResp.message,
    envelope: mime.envelope,
  };
}

/**
 * QUIT and close an SMTP session adapter.
 */
export async function closeSMTPSession(adapter: SocketAdapter): Promise<void> {
  const session = sessions.get(adapter);
  try {
    if (session) {
      await session.write(encodeCommand({ type: "QUIT" }));
      await session.readResponse(false);
    }
  } catch {
    // ignore errors during shutdown
  } finally {
    sessions.delete(adapter);
    await adapter.close();
  }
}

async function ehlo(session: SmtpByteSession, clientName: string): Promise<string[]> {
  await session.write(encodeCommand({ type: "EHLO", domain: clientName }));
  const response = await session.readResponse(false);
  assertResponse(response, [250], "EHLO");
  return parseEHLO(response);
}

async function authenticate(
  session: SmtpByteSession,
  auth: NonNullable<SMTPConfig["auth"]>,
  capabilities: string[],
): Promise<void> {
  if (auth.type === "OAUTH2" && auth.oauth2) {
    const client = new OAuth2Client(auth.oauth2);
    const xoauth2 = await client.buildXOAUTH2();
    await session.write(encodeCommand({ type: "AUTH_XOAUTH2", xoauth2String: xoauth2 }));
    let resp = await session.readResponse(false);
    if (resp.code === 334) {
      await session.write(encodeLine(""));
      resp = await session.readResponse(false);
    }
    assertResponse(resp, [235], "AUTH XOAUTH2");
    return;
  }

  const method = auth.type ?? selectAuthMethod(capabilities);

  if (method === "CRAM-MD5") {
    const pass = requirePassword(auth, "CRAM-MD5");
    await session.write(encodeCommand({ type: "AUTH_CRAM_MD5_INIT" }));
    let resp = await session.readResponse(false);
    assertResponse(resp, [334], "AUTH CRAM-MD5");
    const challenge = resp.message.trim();
    const response = await computeCRAMMD5(challenge, auth.user, pass);
    await session.write(encodeCommand({ type: "AUTH_CRAM_MD5_RESPONSE", response }));
    resp = await session.readResponse(false);
    assertResponse(resp, [235], "AUTH CRAM-MD5 response");
    return;
  }

  if (method === "PLAIN") {
    const pass = requirePassword(auth, "PLAIN");
    await session.write(encodeCommand({ type: "AUTH_PLAIN", user: auth.user, pass }));
    const resp = await session.readResponse(false);
    assertResponse(resp, [235], "AUTH PLAIN");
    return;
  }

  const pass = requirePassword(auth, "LOGIN");
  await session.write(encodeCommand({ type: "AUTH_LOGIN", user: auth.user, pass }));
  let resp = await session.readResponse(false);
  assertResponse(resp, [334], "AUTH LOGIN");

  await session.write(encodeAuthLoginUser(auth.user));
  resp = await session.readResponse(false);
  assertResponse(resp, [334], "AUTH LOGIN user");

  await session.write(encodeAuthLoginPass(pass));
  resp = await session.readResponse(false);
  assertResponse(resp, [235], "AUTH LOGIN pass");
}

function requirePassword(auth: NonNullable<SMTPConfig["auth"]>, method: string): string {
  if (!auth.pass) {
    throw new SentlyError(`Password required for ${method} authentication`, "INVALID_CONFIG", {
      provider: "smtp",
    });
  }
  return auth.pass;
}

/** Reads and parses a complete SMTP response from the adapter. */
async function readSMTPResponse(adapter: SocketAdapter): Promise<SMTPResponse> {
  return sessionFor(adapter).readResponse(false);
}

interface SmtpDeadlines {
  greetingMs: number;
  socketMs: number;
}

const sessions = new WeakMap<SocketAdapter, SmtpByteSession>();

function deadlinesFor(config: ResolvedSMTPConfig | undefined): SmtpDeadlines {
  const connection = config?.connectionTimeout;
  return {
    greetingMs: config?.greetingTimeout ?? connection ?? DEFAULT_GREETING_TIMEOUT_MS,
    socketMs: config?.socketTimeout ?? connection ?? DEFAULT_SOCKET_TIMEOUT_MS,
  };
}

function sessionFor(adapter: SocketAdapter, config?: ResolvedSMTPConfig): SmtpByteSession {
  const existing = sessions.get(adapter);
  if (existing) {
    if (config) {
      existing.deadlines = deadlinesFor(config);
    }
    return existing;
  }
  const session = new SmtpByteSession(adapter, deadlinesFor(config));
  sessions.set(adapter, session);
  return session;
}

class SmtpByteSession {
  /** Bytes left over after the previous complete reply. */
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  /** Active read iterator. A finished iterator is replaced on the next pull. */
  private iterator: AsyncIterator<Uint8Array> | null = null;
  /** True after the greeting has been consumed. */
  private sawGreeting = false;

  /** Creates a byte session for one adapter. */
  constructor(
    private readonly adapter: SocketAdapter,
    /** Greeting and per-reply deadlines. `0` disables that deadline. */
    public deadlines: SmtpDeadlines,
  ) {}

  /** Drop plaintext bytes that arrived with or after the STARTTLS 220. */
  discardPending(): void {
    void this.iterator?.return?.();
    this.iterator = null;
    this.pending = new Uint8Array(0);
  }

  /** Read one SMTP reply. The first call on a session uses the greeting deadline. */
  async readResponse(greeting: boolean): Promise<SMTPResponse> {
    const timeoutMs =
      greeting || !this.sawGreeting ? this.deadlines.greetingMs : this.deadlines.socketMs;
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
    while (true) {
      const split = splitSmtpReply(this.pending);
      if (split) {
        this.pending = split.rest;
        this.sawGreeting = true;
        return parseResponse(split.reply);
      }
      const remaining = deadline - Date.now();
      if (timeoutMs > 0 && remaining <= 0) {
        await this.failTimeout(greeting || !this.sawGreeting);
      }
      const chunk = await this.pull(
        timeoutMs > 0 ? Math.max(1, deadline - Date.now()) : 0,
        greeting || !this.sawGreeting,
      );
      if (chunk === null) {
        throw new SMTPError("Connection closed while reading SMTP response", 0, "READ", "");
      }
      this.pending = concatBytes(this.pending, chunk);
    }
  }

  /** Write bytes with the socket deadline. */
  async write(data: Uint8Array): Promise<void> {
    await withDeadline(
      this.adapter.write(data),
      this.deadlines.socketMs,
      "SMTP write timed out",
      async () => {
        await this.adapter.destroy?.();
      },
    );
  }

  /** Abort the current transaction. Failures close the socket instead of throwing. */
  async resetOrClose(): Promise<void> {
    try {
      await this.write(encodeCommand({ type: "RSET" }));
      const response = await this.readResponse(false);
      if (!response.isSuccess) {
        await this.adapter.close();
      }
    } catch {
      await this.adapter.close().catch(() => undefined);
    }
  }

  private async pull(timeoutMs: number, greeting: boolean): Promise<Uint8Array | null> {
    const next = async (): Promise<IteratorResult<Uint8Array>> => {
      if (!this.iterator) {
        this.iterator = this.adapter.read()[Symbol.asyncIterator]();
      }
      const result = await this.iterator.next();
      if (!result.done) {
        return result;
      }
      this.iterator = this.adapter.read()[Symbol.asyncIterator]();
      return this.iterator.next();
    };
    const result = await withDeadline(
      next(),
      timeoutMs,
      greeting ? "SMTP greeting timed out" : "SMTP response timed out",
      async () => {
        await this.adapter.destroy?.();
      },
    );
    if (result.done) {
      this.iterator = null;
      return null;
    }
    return result.value;
  }

  private async failTimeout(greeting: boolean): Promise<never> {
    await this.adapter.destroy?.();
    throw new SentlyError(
      greeting ? "SMTP greeting timed out" : "SMTP response timed out",
      "TIMEOUT",
      { provider: "smtp" },
    );
  }
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) {
    return right;
  }
  if (right.length === 0) {
    return left;
  }
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return combined;
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout: () => Promise<void> | void,
): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new SentlyError(message, "TIMEOUT", { provider: "smtp" }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch (error) {
    if (error instanceof SentlyError && error.sentlyCode === "TIMEOUT") {
      await Promise.resolve(onTimeout()).catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function defaultClientName(): Promise<string> {
  try {
    const os = await import("node:os");
    const name = os.hostname().trim();
    if (name.length > 0 && !/[\s[\]]/.test(name)) {
      return name;
    }
  } catch {
    // Workers and other runtimes without node:os.
  }
  return "[127.0.0.1]";
}

async function resolveMX(domain: string): Promise<string> {
  const dns = await import("node:dns/promises");
  const records = await dns.resolveMx(domain);
  if (records.length === 0) {
    throw new SMTPError(`No MX records for ${domain}`, 0, "MX", "");
  }
  records.sort((a: { priority: number }, b: { priority: number }) => a.priority - b.priority);
  return records[0]?.exchange ?? domain;
}

export { SMTPError } from "../core/smtp.js";
/** @internal Test helper for raw line writes. */
export { encodeLine, readSMTPResponse };
