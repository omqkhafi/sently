/**
 * @module
 * Cloudflare Workers socket adapter for SMTP via cloudflare:sockets.
 *
 * @example
 * ```ts
 * import { CloudflareAdapter } from "sently/adapters/cf";
 * import { createSMTPMailer } from "sently/smtp";
 *
 * const mailer = await createSMTPMailer({
 *   host: "smtp.example.com",
 *   adapter: new CloudflareAdapter(),
 *   auth: { user: "relay@example.com", pass: "secret" },
 * });
 * ```
 */
import { tlsServerName } from "../core/tls-name.js";
import type { SocketAdapter, TLSOptions } from "../core/types.js";

interface CFSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly closed: Promise<void>;
  close(): Promise<void>;
  startTls(options?: { expectedServerHostname?: string }): CFSocket;
}

type CFConnect = (
  address: { hostname: string; port: number },
  options?: { secureTransport?: "off" | "on" | "starttls"; allowHalfOpen?: boolean },
) => CFSocket;

/** Configuration options for {@link CloudflareAdapter}. */
export interface CloudflareAdapterOptions {
  /** Use implicit TLS on connect (secureTransport: "on"). Default: false. */
  secure?: boolean;
  /** Enable STARTTLS upgrade after plain connect. Default: true when not secure. */
  starttls?: boolean;
  /** Reserved for future TLS tuning (Workers sockets API). */
  tls?: TLSOptions;
}

/**
 * Cloudflare Workers socket adapter via cloudflare:sockets.
 *
 * Limitations:
 * - No connection pooling (isolate lifecycle)
 * - No file system access for attachment.path
 * - No DNS MX lookup — explicit SMTP relay host required
 */
export class CloudflareAdapter implements SocketAdapter {
  /** Underlying Cloudflare Workers socket. */
  private socket: CFSocket | null = null;
  /** Writable stream writer for outbound bytes. */
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  /** Whether the connection is currently encrypted. */
  private _secure: boolean;
  /** Whether the socket is connected. */
  private _connected = false;
  /** Whether implicit TLS is used on connect (port 465 style). */
  private readonly directTls: boolean;
  /** Whether STARTTLS upgrade is enabled after plain connect. */
  private readonly starttls: boolean;
  /** Remote host from the latest connect, used as the default SNI name. */
  private remoteHost = "";

  /** Creates a Cloudflare Workers socket adapter. */
  constructor(options: CloudflareAdapterOptions = {}) {
    this._secure = options.secure ?? false;
    this.directTls = options.secure ?? false;
    this.starttls = options.starttls ?? !this.directTls;
  }

  /** Whether the connection uses TLS. */
  get secure(): boolean {
    return this._secure;
  }

  /** Whether the socket is currently connected. */
  get connected(): boolean {
    return this._connected;
  }

  /** Opens a TCP or TLS connection to the given host and port. */
  async connect(host: string, port: number): Promise<void> {
    this.remoteHost = host;
    const { connect } = (await import("cloudflare:sockets")) as { connect: CFConnect };

    const secureTransport = this.directTls ? "on" : this.starttls ? "starttls" : "off";
    this.socket = connect({ hostname: host, port }, { secureTransport });
    this.writer = this.socket.writable.getWriter();
    this._connected = true;
    this._secure = secureTransport === "on";
  }

  /** Upgrades a plain connection to TLS via STARTTLS. */
  async startTLS(options?: TLSOptions): Promise<void> {
    if (!this.socket || this._secure) {
      throw new Error("Cannot STARTTLS: no plain socket available");
    }

    await this.writer?.close();
    const servername = tlsServerName(this.remoteHost, options?.servername);
    this.socket = servername
      ? this.socket.startTls({ expectedServerHostname: servername })
      : this.socket.startTls();
    this.writer = this.socket.writable.getWriter();
    this._secure = true;
  }

  /** Writes raw bytes to the socket. */
  async write(data: Uint8Array): Promise<void> {
    if (!this.writer) {
      throw new Error("Socket not connected");
    }
    await this.writer.write(data);
  }

  /** Reads incoming socket data as an async iterable of byte chunks. */
  async *read(): AsyncGenerator<Uint8Array, void, unknown> {
    if (!this.socket) {
      throw new Error("Socket not connected");
    }

    const reader = this.socket.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          yield value;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Abort an in-flight read or handshake.
   * SMTP deadlines call this when a timer fires.
   */
  async destroy(): Promise<void> {
    await this.close();
  }

  /** Closes the socket connection. */
  async close(): Promise<void> {
    await this.writer?.close();
    await this.socket?.close();
    this.writer = null;
    this.socket = null;
    this._connected = false;
  }
}
