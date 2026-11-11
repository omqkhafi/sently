/**
 * @module
 * WhatsApp sender orchestrator — plugins, hooks, and transport.send pipeline.
 *
 * Sently-first: apps call {@link createWhatsAppSender}; providers implement
 * {@link WhatsAppTransport}. Multi-product vendors get a separate WhatsApp
 * transport (e.g. `taqnyat-whatsapp`), not a mega vendor client.
 *
 * @example
 * ```ts
 * import { createWhatsAppSender } from "sently/whatsapp";
 * import { WhatsAppCloudTransport } from "sently/transports/whatsapp-cloud";
 *
 * const wa = createWhatsAppSender({
 *   transport: new WhatsAppCloudTransport({
 *     accessToken: "...",
 *     phoneNumberId: "...",
 *   }),
 * });
 *
 * await wa.send({ to: "15551234567", text: "Hello" });
 * ```
 */
import { isFallbackHookTransport, isRetryHookTransport } from "./core/decorator-hooks.js";
import { invokeHook } from "./core/hooks.js";
import { runPlugins } from "./core/plugin.js";
import { runWithSendHooks, type SendHookSlot } from "./core/send-context.js";
import type { VerifyResult } from "./core/types.js";
import type {
  WhatsAppHookContext,
  WhatsAppHooks,
  WhatsAppOptions,
  WhatsAppPlugin,
  WhatsAppSendResult,
  WhatsAppTransport,
} from "./core/whatsapp-types.js";

/** Configuration for {@link createWhatsAppSender}. */
export interface WhatsAppSenderConfig {
  /** WhatsApp delivery transport. */
  transport: WhatsAppTransport;
  /** Optional plugins run before each send. */
  plugins?: WhatsAppPlugin[];
  /** Optional lifecycle hooks for metrics and tracing. */
  hooks?: WhatsAppHooks;
}

/** WhatsApp sender returned by {@link createWhatsAppSender}. */
export interface WhatsAppSender {
  /** Send a WhatsApp message through the configured transport. */
  send(options: WhatsAppOptions): Promise<WhatsAppSendResult>;
  /** Test connectivity and credentials without sending. */
  verify(): Promise<VerifyResult>;
  /** Release resources held by the transport. */
  close(): Promise<void>;
}

function buildWhatsAppHookContext(
  options: WhatsAppOptions,
  transport: WhatsAppTransport,
): WhatsAppHookContext {
  return {
    ...(options.messageId !== undefined ? { messageId: options.messageId } : {}),
    to: options.to,
    provider: transport.provider ?? "whatsapp",
  };
}

/**
 * Create a WhatsApp sender that wraps a {@link WhatsAppTransport}.
 *
 * Pipeline: plugins → onSend → transport.send → onSuccess / onError.
 * `onRetry` / `onFallback` wire when the transport is a retry or fallback decorator.
 */
export function createWhatsAppSender(config: WhatsAppSenderConfig): WhatsAppSender {
  const { transport, plugins, hooks } = config;

  return {
    async send(options: WhatsAppOptions): Promise<WhatsAppSendResult> {
      const processed = await runPlugins(options, plugins);
      const ctx = buildWhatsAppHookContext(processed, transport);

      await invokeHook(hooks?.onSend, ctx);

      const slot: SendHookSlot = {};
      if (hooks?.onRetry !== undefined && isRetryHookTransport(transport)) {
        slot.onRetry = (attempt, error) => {
          void invokeHook(hooks.onRetry, ctx, attempt, error);
        };
      }
      if (hooks?.onFallback !== undefined && isFallbackHookTransport(transport)) {
        slot.onFallback = (failedProvider, nextProvider, error) =>
          invokeHook(hooks.onFallback, ctx, failedProvider, nextProvider, error);
      }

      const start = performance.now();

      try {
        const result = await runWithSendHooks(slot, () => transport.send(processed));
        const successCtx: WhatsAppHookContext = {
          ...ctx,
          messageId: result.messageId,
        };
        await invokeHook(hooks?.onSuccess, successCtx, result, performance.now() - start);
        return result;
      } catch (error) {
        await invokeHook(hooks?.onError, ctx, error, performance.now() - start);
        throw error;
      }
    },

    async verify(): Promise<VerifyResult> {
      if (transport.verify) {
        return transport.verify();
      }
      return { ok: true, provider: "whatsapp" };
    },

    async close(): Promise<void> {
      if (transport.close) {
        await transport.close();
      }
    },
  };
}
