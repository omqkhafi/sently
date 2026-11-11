import { buildMIME } from "../core/mime.js";
import type { MailOptions, SendResult, SMTPConfig, SocketAdapter } from "../core/types.js";
import { resolveAttachments } from "../transports/resolve-attachments.js";
import {
  closeSMTPSession,
  deliverSMTPMessage,
  openSMTPSession,
  resolveSMTPConfig,
} from "../transports/smtp.js";

/** A single pooled SMTP connection with a persistent session. */
export interface PooledConnection {
  /** Send one message over this connection. */
  send(options: MailOptions): Promise<SendResult>;
  /** Whether this connection is idle and available for work. */
  readonly idle: boolean;
  /** Number of messages sent on this connection. */
  readonly messageCount: number;
  /** Whether this connection can accept more messages before recycle. */
  readonly usable: boolean;
  /** Close the connection and end the SMTP session. */
  close(): Promise<void>;
  /** Abort the socket so an in-flight handshake or send settles. */
  destroy(): Promise<void>;
}

/** Options for creating a pooled connection. */
export interface PooledConnectionOptions {
  /** SMTP configuration for the pooled session. */
  config: SMTPConfig;
  /** Maximum messages before this connection is recycled. */
  maxMessages: number;
  /** Hostname to connect to (may differ from config.host for direct MX). */
  connectHost: string;
  /** Factory that creates the socket adapter for this connection. */
  createAdapter: () => Promise<SocketAdapter>;
  /**
   * Called with the adapter as soon as it exists, before connect.
   * A send deadline uses this to abort a handshake that has not returned a connection yet.
   */
  onAdapter?: (adapter: SocketAdapter) => void;
}

/**
 * Create a pooled SMTP connection with an open authenticated session.
 */
export async function createPooledConnection(
  options: PooledConnectionOptions,
): Promise<PooledConnection> {
  const config = resolveSMTPConfig(options.config);
  const adapter = await options.createAdapter();
  options.onAdapter?.(adapter);
  let capabilities: string[];
  try {
    await adapter.connect(options.connectHost, config.port);
    capabilities = await openSMTPSession(adapter, config);
  } catch (error) {
    await adapter.close().catch(() => undefined);
    throw error;
  }
  const allow8BitMime = capabilities.some((cap) => cap.toUpperCase() === "8BITMIME");

  let messageCount = 0;
  let idle = true;
  let sendChain: Promise<void> = Promise.resolve();

  const maxMessages = options.maxMessages;

  return {
    get idle(): boolean {
      return idle;
    },
    get messageCount(): number {
      return messageCount;
    },
    get usable(): boolean {
      return messageCount < maxMessages;
    },

    async send(mailOptions: MailOptions): Promise<SendResult> {
      const run = async (): Promise<SendResult> => {
        idle = false;
        try {
          const resolvedOptions = {
            ...mailOptions,
            attachments: await resolveAttachments(mailOptions.attachments, {
              ...(config.attachmentBasePath !== undefined
                ? { basePath: config.attachmentBasePath }
                : {}),
            }),
          };
          const mime = await buildMIME(resolvedOptions, config.dkim, { allow8BitMime });
          const result = await deliverSMTPMessage(adapter, mime);
          messageCount += 1;
          return result;
        } finally {
          idle = true;
        }
      };

      const resultPromise = sendChain.then(run);
      sendChain = resultPromise.then(
        () => undefined,
        () => undefined,
      );
      return resultPromise;
    },

    async close(): Promise<void> {
      await sendChain;
      await closeSMTPSession(adapter);
    },

    async destroy(): Promise<void> {
      await adapter.destroy?.();
    },
  };
}
