/**
 * @module
 * Deno socket adapter for SMTP connections via Deno.connect and Deno.startTls.
 *
 * @example
 * ```ts
 * import { DenoAdapter } from "sently/adapters/deno";
 * import { createSMTPMailer } from "sently/smtp";
 *
 * const mailer = await createSMTPMailer({
 *   host: "smtp.example.com",
 *   adapter: new DenoAdapter(),
 *   auth: { user: "you@example.com", pass: "secret" },
 * });
 * ```
 */
import { tlsServerName } from "../core/tls-name.js";
import type { SocketAdapter, TLSOptions } from "../core/types.js";

declare const Deno: {
  connect(options: { hostname: string; port: number }): Promise<DenoTcpConn>;
  connectTls(options: {
    hostname: string;
    port: number;
    [key: string]: unknown;
  }): Promise<DenoTlsConn>;
  startTls(conn: DenoTcpConn, options?: { hostname?: string }): Promise<DenoTlsConn>;
};

interface DenoConn {
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
  close(): void;
}

interface DenoTcpConn extends DenoConn {}
interface DenoTlsConn extends DenoConn {}

/** Configuration options for {@link DenoAdapter}. */
export interface DenoAdapterOptions {
  /** Use implicit TLS on connect (port 465). Default: false. */
  secure?: boolean;
  /** Socket connect timeout in milliseconds. Default: 30_000. */
  connectionTimeout?: number;
  /** TLS options passed to Deno.startTls / Deno.connectTls. */
  tls?: TLSOptions;
}

/**
 * Deno socket adapter using Deno.connect / Deno.startTls.
 */
export class DenoAdapter implements SocketAdapter {
  /** Active Deno TCP or TLS connection. */
  private conn: DenoConn | null = null;
  /** Whether the connection is currently encrypted. */
  private _secure: boolean;
  /** Whether the socket is connected. */
  private _connected = false;
  /** TLS options for direct TLS and STARTTLS upgrades. */
  private readonly tlsOptions: TLSOptions;
  /** Remote host from the latest connect, used as the default SNI name. */
  private remoteHost = "";

  /** Creates a Deno socket adapter (requires the Deno runtime). */
  constructor(options: DenoAdapterOptions = {}) {
    if (typeof Deno === "undefined") {
      throw new Error("DenoAdapter requires the Deno runtime");
    }
    this._secure = options.secure ?? false;
    this.tlsOptions = options.tls ?? {};
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
    if (this._secure) {
      const servername = tlsServerName(host, this.tlsOptions.servername);
      this.conn = await Deno.connectTls({
        hostname: host,
        port,
        ...(servername !== undefined ? { servername } : {}),
      });
    } else {
      this.conn = await Deno.connect({ hostname: host, port });
    }
    this._connected = true;
  }

  /** Upgrades a plain connection to TLS via STARTTLS. */
  async startTLS(options?: TLSOptions): Promise<void> {
    if (!this.conn || this._secure) {
      throw new Error("Cannot STARTTLS: no plain connection available");
    }

    const merged = { ...this.tlsOptions, ...options };
    const servername = tlsServerName(this.remoteHost, merged.servername);
    this.conn = await Deno.startTls(this.conn as DenoTcpConn, {
      ...(servername !== undefined ? { hostname: servername } : {}),
    });
    this._secure = true;
  }

  /** Writes raw bytes to the socket. */
  async write(data: Uint8Array): Promise<void> {
    if (!this.conn) {
      throw new Error("Socket not connected");
    }
    await this.conn.write(data);
  }

  /** Reads incoming socket data as an async iterable of byte chunks. */
  async *read(): AsyncGenerator<Uint8Array, void, unknown> {
    if (!this.conn) {
      throw new Error("Socket not connected");
    }

    const buffer = new Uint8Array(8192);
    while (true) {
      const n = await this.conn.read(buffer);
      if (n === null) {
        break;
      }
      yield buffer.slice(0, n);
    }
  }

  /** Closes the socket connection. */
  async close(): Promise<void> {
    this.conn?.close();
    this.conn = null;
    this._connected = false;
  }

  /**
   * Abort an in-flight read or handshake.
   * SMTP deadlines call this when a timer fires.
   */
  async destroy(): Promise<void> {
    await this.close();
  }
}
