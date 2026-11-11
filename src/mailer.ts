/**
 * @module
 * Lightweight mailer factory for custom transports — no SMTP code in the bundle.
 *
 * Sently-first: apps call {@link createMailer}; providers implement `Transport`.
 * Use this entry instead of `sently` when you pass a transport explicitly
 * (Resend, SendGrid, etc.) and want the smallest bundle size.
 *
 * @example
 * ```ts
 * import { createMailer } from "sently/mailer";
 * import { ResendTransport } from "sently/transports/resend";
 *
 * const mailer = await createMailer({
 *   transport: new ResendTransport({ apiKey: process.env.RESEND_API_KEY! }),
 * });
 *
 * await mailer.send({
 *   from: "onboarding@yourdomain.com",
 *   to: "recipient@example.com",
 *   subject: "Hello",
 *   html: "<p>Sent via Resend</p>",
 * });
 * ```
 */
import { extractEmails } from "./core/address.js";
import { isFallbackHookTransport, isRetryHookTransport } from "./core/decorator-hooks.js";
import { SentlyError } from "./core/errors.js";
import { invokeHook } from "./core/hooks.js";
import { runPlugins } from "./core/plugin.js";
import { getProviderLabel } from "./core/provider-label.js";
import { RateLimiter } from "./core/rate-limiter.js";
import { runWithSendHooks, type SendHookSlot } from "./core/send-context.js";
import type {
  BulkSendOptions,
  BulkSendResult,
  Mailer,
  MailerHookContext,
  MailerHooks,
  MailOptions,
  MailPlugin,
  SendResult,
  Transport,
  TransportMailerOptions,
  VerifyResult,
} from "./core/types.js";

export type { MailerHookContext, MailerHooks, TransportMailerOptions };

const TRANSPORT_ONLY_SMTP_CONFIG_MESSAGE =
  "SMTP config passed to transport-only createMailer. Use: import { createSMTPMailer } from 'sently' or import { createSMTPMailer } from 'sently/smtp'.";

/**
 * Create a mailer that wraps a custom {@link Transport} (HTTP API, preview, retry, etc.).
 */
export async function createMailer(options: TransportMailerOptions): Promise<Mailer> {
  if (options.transport === undefined || ("host" in options && options.transport === undefined)) {
    throw new SentlyError(TRANSPORT_ONLY_SMTP_CONFIG_MESSAGE, "INVALID_CONFIG");
  }

  return new MailerImpl(options.transport, options.plugins ?? [], options.hooks);
}

function hasAttachments(message: MailOptions): boolean {
  return message.attachments !== undefined && message.attachments.length > 0;
}

/** Infer a provider label from a transport instance for hook context. */
function inferProvider(transport: Transport): string {
  return getProviderLabel(transport);
}

/** Build hook context from mail options (no body fields). */
function buildHookContext(options: MailOptions, transport: Transport): MailerHookContext {
  return {
    ...(options.messageId !== undefined ? { messageId: options.messageId } : {}),
    to: extractEmails(options.to),
    subject: options.subject,
    provider: inferProvider(transport),
  };
}

/** Internal mailer implementation shared with the full `sently` entry. */
export class MailerImpl implements Mailer {
  constructor(
    private readonly transport: Transport,
    private readonly plugins: MailPlugin[] = [],
    private readonly hooks?: MailerHooks,
  ) {}

  async send(options: MailOptions): Promise<SendResult> {
    const processed = await runPlugins(options, this.plugins);
    if (processed.to === undefined || processed.to === null) {
      throw new SentlyError("Missing to address", "INVALID_CONFIG");
    }
    const ctx = buildHookContext(processed, this.transport);

    await invokeHook(this.hooks?.onSend, ctx);

    const slot: SendHookSlot = {};
    if (this.hooks?.onRetry !== undefined && isRetryHookTransport(this.transport)) {
      slot.onRetry = (attempt, error) => {
        void invokeHook(this.hooks?.onRetry, ctx, attempt, error);
      };
    }
    if (this.hooks?.onFallback !== undefined && isFallbackHookTransport(this.transport)) {
      slot.onFallback = (failedProvider, nextProvider, error) =>
        invokeHook(this.hooks?.onFallback, ctx, failedProvider, nextProvider, error);
    }

    const start = performance.now();

    try {
      const result = await runWithSendHooks(slot, () => this.transport.send(processed));
      const successCtx: MailerHookContext = {
        ...ctx,
        messageId: result.messageId,
      };
      await invokeHook(this.hooks?.onSuccess, successCtx, result, performance.now() - start);
      return result;
    } catch (error) {
      await invokeHook(this.hooks?.onError, ctx, error, performance.now() - start);
      throw error;
    }
  }

  private async processMessage(message: MailOptions): Promise<MailOptions> {
    return runPlugins(message, this.plugins);
  }

  async sendBulk(messages: MailOptions[], options?: BulkSendOptions): Promise<BulkSendResult> {
    if (messages.length === 0) {
      return { total: 0, sent: 0, failed: 0, results: [] };
    }
    assertBulkConcurrency(options?.concurrency);

    const results: BulkSendResult["results"] = new Array(messages.length);
    const stopOnError = options?.stopOnError ?? false;
    let halted = false;

    const recordSuccess = async (
      message: MailOptions,
      index: number,
      result: SendResult,
      processed?: MailOptions,
      durationMs?: number,
    ): Promise<void> => {
      results[index] = { status: "sent", result };
      if (processed !== undefined && this.hooks !== undefined) {
        const ctx = buildHookContext(processed, this.transport);
        await invokeHook(this.hooks.onSend, ctx);
        await invokeHook(
          this.hooks.onSuccess,
          { ...ctx, messageId: result.messageId },
          result,
          durationMs,
        );
      }
      try {
        options?.onSuccess?.(message, index, result);
      } catch (callbackError) {
        console.warn(
          "[sently] onSuccess threw; the send is still recorded as sent:",
          callbackError,
        );
      }
    };

    const recordFailure = async (
      message: MailOptions,
      index: number,
      error: unknown,
      processed?: MailOptions,
      durationMs?: number,
    ): Promise<void> => {
      results[index] = { status: "failed", error };
      if (processed !== undefined && this.hooks !== undefined) {
        const ctx = buildHookContext(processed, this.transport);
        await invokeHook(this.hooks.onSend, ctx);
        await invokeHook(this.hooks.onError, ctx, error, durationMs);
      }
      options?.onError?.(message, index, error);
      if (stopOnError) {
        halted = true;
      }
    };

    if (this.transport.sendBatch) {
      const batchEntries: Array<{ index: number; message: MailOptions }> = [];
      const singleEntries: Array<{ index: number; message: MailOptions }> = [];

      for (const [index, message] of messages.entries()) {
        if (hasAttachments(message)) {
          singleEntries.push({ index, message });
        } else {
          batchEntries.push({ index, message });
        }
      }

      if (batchEntries.length > 0 && !halted) {
        const chunkSize = this.transport.batchMax ?? batchEntries.length;
        const rateDelta = options?.rateDelta ?? 2;
        const rateLimiter =
          rateDelta > 0
            ? new RateLimiter(rateDelta, options?.rateLimit ?? 1000, options?.now)
            : null;

        for (
          let chunkStart = 0;
          chunkStart < batchEntries.length && !halted;
          chunkStart += chunkSize
        ) {
          const chunk = batchEntries.slice(chunkStart, chunkStart + chunkSize);

          if (rateLimiter) {
            await rateLimiter.acquire();
          }

          try {
            const processed = await Promise.all(
              chunk.map(({ message }) => this.processMessage(message)),
            );
            const batchStart = performance.now();
            const batchResults = await this.transport.sendBatch(processed);
            const batchDurationMs = performance.now() - batchStart;

            for (let i = 0; i < chunk.length; i++) {
              const entry = chunk[i] as { index: number; message: MailOptions };
              const processedMessage = processed[i] as MailOptions;
              const result = batchResults[i];
              if (result === undefined) {
                await recordFailure(
                  entry.message,
                  entry.index,
                  new Error("Batch response missing result for message"),
                  processedMessage,
                  batchDurationMs,
                );
              } else if (result.batchError !== undefined) {
                await recordFailure(
                  entry.message,
                  entry.index,
                  result.batchError,
                  processedMessage,
                  batchDurationMs,
                );
              } else {
                await recordSuccess(
                  entry.message,
                  entry.index,
                  result,
                  processedMessage,
                  batchDurationMs,
                );
              }
            }
          } catch (error) {
            const processed = await Promise.all(
              chunk.map(({ message }) => this.processMessage(message)),
            );
            for (let i = 0; i < chunk.length; i++) {
              if (halted) {
                break;
              }
              const entry = chunk[i] as { index: number; message: MailOptions };
              await recordFailure(entry.message, entry.index, error, processed[i]);
            }
          }
        }
      }

      if (singleEntries.length > 0 && !halted) {
        const concurrency = options?.concurrency ?? 1;
        const queue = [...singleEntries];
        let active = 0;

        await new Promise<void>((resolve) => {
          const maybeDone = (): void => {
            if ((queue.length === 0 && active === 0) || halted) {
              resolve();
            }
          };

          const processNext = (): void => {
            if (queue.length === 0 || halted) {
              maybeDone();
              return;
            }

            const entry = queue.shift();
            if (entry === undefined) {
              maybeDone();
              return;
            }

            active++;
            void this.send(entry.message)
              .then((result) => {
                results[entry.index] = { status: "sent", result };
                try {
                  options?.onSuccess?.(entry.message, entry.index, result);
                } catch (callbackError) {
                  console.warn(
                    "[sently] onSuccess threw; the send is still recorded as sent:",
                    callbackError,
                  );
                }
              })
              .catch((error: unknown) => {
                results[entry.index] = { status: "failed", error };
                options?.onError?.(entry.message, entry.index, error);
                if (stopOnError) {
                  halted = true;
                }
              })
              .finally(() => {
                active--;
                processNext();
                maybeDone();
              });
          };

          for (let i = 0; i < concurrency; i++) {
            processNext();
          }
        });
      }
    } else {
      const concurrency = options?.concurrency ?? 1;
      const queue = [...messages.entries()];
      let active = 0;

      await new Promise<void>((resolve) => {
        const maybeDone = (): void => {
          if ((queue.length === 0 && active === 0) || halted) {
            resolve();
          }
        };

        const processNext = (): void => {
          if (queue.length === 0 || halted) {
            maybeDone();
            return;
          }

          const entry = queue.shift();
          if (entry === undefined) {
            maybeDone();
            return;
          }

          const [index, message] = entry;
          active++;

          void this.send(message)
            .then((result) => {
              results[index] = { status: "sent", result };
              try {
                options?.onSuccess?.(message, index, result);
              } catch (callbackError) {
                console.warn(
                  "[sently] onSuccess threw; the send is still recorded as sent:",
                  callbackError,
                );
              }
            })
            .catch((error: unknown) => {
              results[index] = { status: "failed", error };
              options?.onError?.(message, index, error);
              if (stopOnError) {
                halted = true;
              }
            })
            .finally(() => {
              active--;
              processNext();
              maybeDone();
            });
        };

        for (let i = 0; i < concurrency; i++) {
          processNext();
        }
      });
    }

    let sent = 0;
    let failed = 0;
    for (const result of results) {
      if (result === undefined) {
        continue;
      }
      if (result.status === "sent") {
        sent++;
      } else {
        failed++;
      }
    }

    return {
      total: messages.length,
      sent,
      failed,
      results,
    };
  }

  verify(): Promise<VerifyResult> {
    if (this.transport.verify) {
      return this.transport.verify();
    }
    return Promise.resolve({ ok: true, provider: "mailer" });
  }

  close(): Promise<void> {
    if (this.transport.close) {
      return this.transport.close();
    }
    return Promise.resolve();
  }
}

function assertBulkConcurrency(concurrency: number | undefined): void {
  if (concurrency === undefined) {
    return;
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new SentlyError(
      "concurrency must be a finite integer greater than or equal to 1",
      "INVALID_CONFIG",
    );
  }
}
