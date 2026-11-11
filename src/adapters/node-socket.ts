/**
 * Shared Node.js `net`/`tls` socket used by {@link NodeAdapter} and {@link BunAdapter}.
 * Inbound bytes stay queued across `read()` calls so nothing is dropped between SMTP replies.
 */
import net from "node:net";
import tls from "node:tls";
import { SentlyError } from "../core/errors.js";
import { tlsServerName } from "../core/tls-name.js";
import type { SocketAdapter, TLSOptions } from "../core/types.js";

/**
 * Finish a socket without waiting only on `end(callback)`.
 * After a failed STARTTLS that callback often never runs.
 */
function finishSocket(socket: net.Socket): Promise<void> {
  if (socket.destroyed) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    socket.once("close", done);
    try {
      socket.end();
    } catch {
      // Already unusable. destroy() still releases the handle.
    }
    socket.destroy();
    done();
  });
}

function warnRejectUnauthorizedDisabled(options: TLSOptions): void {
  if (options.rejectUnauthorized === false) {
    console.warn(
      "[sently] TLS certificate verification is disabled. " +
        "Never use rejectUnauthorized: false in production.",
    );
  }
}

/** Options for {@link NodeCompatSocket}. */
export interface NodeCompatSocketOptions {
  /** Use implicit TLS on connect (port 465). Default: false. */
  secure?: boolean;
  /** Socket connect timeout in milliseconds. Default: 30_000. `0` disables. */
  connectionTimeout?: number;
  /** TLS options passed to node:tls. */
  tls?: TLSOptions;
}

/**
 * TCP/TLS socket with a persistent inbound queue and a connect deadline
 * that is cleared after the handshake.
 */
export class NodeCompatSocket implements SocketAdapter {
  /** Underlying Node.js TCP or TLS socket. */
  private socket: net.Socket | tls.TLSSocket | null = null;
  /** Whether connect() should use implicit TLS. */
  private readonly implicitTls: boolean;
  /** Whether the connection is currently encrypted. */
  private _secure: boolean;
  /** Whether the socket is connected. */
  private _connected = false;
  /** Socket connect timeout in milliseconds. */
  private readonly connectionTimeout: number;
  /** TLS options for direct TLS and STARTTLS upgrades. */
  private readonly tlsOptions: TLSOptions;
  /** Remote host from the latest `connect`, used as the default SNI name. */
  private remoteHost = "";
  /**
   * STARTTLS wrapper.
   * It does not replace {@link socket} until `secureConnect`, so a failed
   * handshake still has to tear both sockets down.
   */
  private tlsSocket: tls.TLSSocket | null = null;
  /** Bytes received while no `read()` consumer is waiting. */
  private queue: Uint8Array[] = [];
  /** Waiters blocked inside `read()`. */
  private readers: Array<(value: Uint8Array | null) => void> = [];
  /** Error from the current socket, if the connection failed. */
  private readError: Error | null = null;
  /** True after the current socket has closed. */
  private readClosed = false;

  /** Creates a Node-compatible socket adapter. */
  constructor(options: NodeCompatSocketOptions = {}) {
    this.implicitTls = options.secure ?? false;
    this._secure = this.implicitTls;
    this.connectionTimeout = options.connectionTimeout ?? 30_000;
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
    this._secure = this.implicitTls;
    if (this.implicitTls) {
      await this.connectTls(host, port);
    } else {
      await this.connectPlain(host, port);
    }
    this._connected = true;
  }

  /** Upgrades a plain connection to TLS via STARTTLS. */
  async startTLS(options?: TLSOptions): Promise<void> {
    if (!this.socket || this._secure) {
      throw new SentlyError("Cannot STARTTLS: no plain socket available", "TLS_FAILED", {
        provider: "smtp",
      });
    }

    const plain = this.socket;
    const merged = { ...this.tlsOptions, ...options };
    warnRejectUnauthorizedDisabled(merged);
    const servername = tlsServerName(this.remoteHost, merged.servername);
    this.prepareStartTls();

    const tlsSocket = tls.connect({
      socket: plain,
      ...(servername !== undefined ? { servername } : {}),
      rejectUnauthorized: merged.rejectUnauthorized ?? true,
      ...(merged.minVersion !== undefined ? { minVersion: merged.minVersion } : {}),
    });
    this.tlsSocket = tlsSocket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        tlsSocket.setTimeout(0);
        const wrapped = error instanceof SentlyError ? error : wrapSocketError(error);
        // Destroy the plaintext socket too. Destroying only the TLS wrapper
        // leaves close() waiting on an end() callback that never runs.
        void this.destroy().then(
          () => reject(wrapped),
          () => reject(wrapped),
        );
      };

      if (this.connectionTimeout > 0) {
        tlsSocket.setTimeout(this.connectionTimeout);
        tlsSocket.once("timeout", () => {
          fail(new SentlyError("TLS handshake timed out", "TIMEOUT", { provider: "smtp" }));
        });
      }
      tlsSocket.once("secureConnect", () => {
        if (settled) {
          return;
        }
        settled = true;
        tlsSocket.setTimeout(0);
        this.tlsSocket = null;
        this.socket = tlsSocket;
        this._secure = true;
        this.attachIo(tlsSocket);
        resolve();
      });
      tlsSocket.once("error", (error) => {
        fail(error);
      });
    });
  }

  /** Writes raw bytes to the socket. */
  async write(data: Uint8Array): Promise<void> {
    if (!this.socket) {
      throw new SentlyError("Socket not connected", "CONNECTION_FAILED", { provider: "smtp" });
    }

    const socket = this.socket;
    await new Promise<void>((resolve, reject) => {
      socket.write(Buffer.from(data), (error) => {
        if (error) {
          reject(wrapSocketError(error));
        } else {
          resolve();
        }
      });
    });
  }

  /** Reads incoming socket data as an async iterable of byte chunks. */
  async *read(): AsyncGenerator<Uint8Array, void, unknown> {
    if (!this.socket && this.queue.length === 0 && !this.readClosed) {
      throw new SentlyError("Socket not connected", "CONNECTION_FAILED", { provider: "smtp" });
    }

    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift() as Uint8Array;
        continue;
      }
      if (this.readError) {
        throw this.readError;
      }
      if (this.readClosed) {
        return;
      }
      const next = await new Promise<Uint8Array | null>((resolve) => {
        this.readers.push(resolve);
      });
      if (next === null) {
        if (this.readError) {
          throw this.readError;
        }
        return;
      }
      yield next;
    }
  }

  /** Drop bytes already queued but not yet consumed. */
  discardBuffered(): void {
    this.queue = [];
  }

  /**
   * Detach plaintext listeners before STARTTLS.
   * Queued SMTP bytes are dropped so they are not parsed as the next reply
   * and are not stolen from the TLS stack.
   */
  prepareStartTls(): void {
    this.detachIo(this.socket);
    this.queue = [];
    this.readError = null;
    this.readClosed = false;
  }

  /** Closes the socket connection. */
  async close(): Promise<void> {
    const sockets = this.takeSockets();
    this.flushReaders(null);
    await Promise.all(sockets.map((socket) => finishSocket(socket)));
  }

  /** Destroy the socket so an in-flight read or write settles. */
  async destroy(): Promise<void> {
    const sockets = this.takeSockets();
    this.readError = new SentlyError("SMTP response timed out", "TIMEOUT", { provider: "smtp" });
    this.flushReaders(null);
    for (const socket of sockets) {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
  }

  /**
   * Detach and forget the plaintext socket and any in-flight TLS wrapper.
   * A later {@link close} is then a no-op.
   */
  private takeSockets(): Array<net.Socket | tls.TLSSocket> {
    const sockets: Array<net.Socket | tls.TLSSocket> = [];
    if (this.socket) {
      sockets.push(this.socket);
    }
    if (this.tlsSocket && this.tlsSocket !== this.socket) {
      sockets.push(this.tlsSocket);
    }
    this.detachIo(this.socket);
    this.socket = null;
    this.tlsSocket = null;
    this._connected = false;
    this._secure = this.implicitTls;
    this.readClosed = true;
    return sockets;
  }

  /** Opens a plain TCP connection to the SMTP server. */
  private connectPlain(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      this.socket = socket;
      this.armConnect(socket, resolve, reject, () => {
        this.attachIo(socket);
      });
    });
  }

  /** Opens a direct TLS connection to the SMTP server. */
  private connectTls(host: string, port: number): Promise<void> {
    warnRejectUnauthorizedDisabled(this.tlsOptions);
    const servername = tlsServerName(host, this.tlsOptions.servername);
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host,
        port,
        ...(servername !== undefined ? { servername } : {}),
        rejectUnauthorized: this.tlsOptions.rejectUnauthorized ?? true,
        ...(this.tlsOptions.minVersion !== undefined
          ? { minVersion: this.tlsOptions.minVersion }
          : {}),
      });
      this.socket = socket;
      this.armConnect(socket, resolve, reject, () => {
        this.attachIo(socket);
      });
    });
  }

  /** Apply the connect deadline and clear it once the handshake succeeds. */
  private armConnect(
    socket: net.Socket,
    resolve: () => void,
    reject: (error: unknown) => void,
    onReady: () => void,
  ): void {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(error instanceof SentlyError ? error : wrapSocketError(error));
    };
    const onTimeout = (): void => {
      fail(new SentlyError("Connection timeout", "TIMEOUT", { provider: "smtp" }));
    };
    if (this.connectionTimeout > 0) {
      socket.setTimeout(this.connectionTimeout);
      socket.once("timeout", onTimeout);
    }
    socket.once("error", (error) => {
      fail(error);
    });
    const onReadyEvent = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.setTimeout(0);
      socket.off("timeout", onTimeout);
      onReady();
      resolve();
    };
    if (this.implicitTls) {
      socket.once("secureConnect", onReadyEvent);
    } else {
      socket.once("connect", onReadyEvent);
    }
  }

  /** Listen for the lifetime of this socket. */
  private attachIo(socket: net.Socket): void {
    this.queue = [];
    this.readError = null;
    this.readClosed = false;
    socket.on("data", (chunk: Buffer) => {
      this.enqueue(new Uint8Array(chunk));
    });
    socket.on("error", (error) => {
      this.readError = wrapSocketError(error);
      this.readClosed = true;
      this.flushReaders(null);
    });
    socket.on("close", () => {
      this.readClosed = true;
      this.flushReaders(null);
    });
  }

  /** Remove inbound listeners before upgrade, close, or destroy. */
  private detachIo(socket: net.Socket | null): void {
    socket?.removeAllListeners("data");
    socket?.removeAllListeners("error");
    socket?.removeAllListeners("close");
  }

  /** Deliver one chunk to a waiting reader or keep it. */
  private enqueue(data: Uint8Array): void {
    const waiter = this.readers.shift();
    if (waiter) {
      waiter(data);
    } else {
      this.queue.push(data);
    }
  }

  /** Wake every blocked reader. */
  private flushReaders(value: Uint8Array | null): void {
    const waiters = this.readers;
    this.readers = [];
    for (const waiter of waiters) {
      waiter(value);
    }
  }
}

/**
 * Map a raw socket or TLS failure onto a {@link SentlyError}.
 * The original error is kept on `cause`.
 *
 * @param error - Value thrown by node:net or node:tls
 */
export function wrapSocketError(error: unknown): SentlyError {
  if (error instanceof SentlyError) {
    return error;
  }
  const cause = error instanceof Error ? error : new Error(String(error));
  const code =
    "code" in cause && typeof (cause as { code?: unknown }).code === "string"
      ? (cause as { code: string }).code
      : "";
  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "ECONNRESET"
  ) {
    return new SentlyError("SMTP connection failed", "CONNECTION_FAILED", {
      provider: "smtp",
      cause,
    });
  }
  if (
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "CERT_HAS_EXPIRED" ||
    code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
    /certificate|tls|ssl|ServerName/i.test(cause.message)
  ) {
    return new SentlyError("TLS handshake failed", "TLS_FAILED", { provider: "smtp", cause });
  }
  if (code === "ETIMEDOUT" || /timeout/i.test(cause.message)) {
    return new SentlyError("Connection timeout", "TIMEOUT", { provider: "smtp", cause });
  }
  return new SentlyError("SMTP connection failed", "CONNECTION_FAILED", {
    provider: "smtp",
    cause,
  });
}
