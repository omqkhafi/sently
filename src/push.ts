/**
 * @module
 * Push sender orchestrator — plugins, hooks, and transport.send pipeline.
 *
 * Sently-first: apps call {@link createPushSender}; providers implement
 * {@link PushTransport} (Web Push or FCM).
 *
 * @example
 * ```ts
 * import { createPushSender } from "sently/push";
 * import { WebPushTransport } from "sently/transports/webpush";
 *
 * const push = createPushSender({
 *   transport: new WebPushTransport({
 *     vapidPublicKey: "...",
 *     vapidPrivateKey: "...",
 *     subject: "mailto:you@example.com",
 *   }),
 * });
 *
 * await push.send({
 *   subscription: { endpoint: "...", keys: { p256dh: "...", auth: "..." } },
 *   title: "Hello",
 *   body: "World",
 * });
 * ```
 */
import { isFallbackHookTransport, isRetryHookTransport } from "./core/decorator-hooks.js";
import { invokeHook } from "./core/hooks.js";
import { runPlugins } from "./core/plugin.js";
import { redactFcmToken, redactPushEndpoint } from "./core/push-endpoint.js";
import type {
  PushHookContext,
  PushHooks,
  PushOptions,
  PushPlugin,
  PushSendResult,
  PushTransport,
} from "./core/push-types.js";
import { isFcmPushOptions, isWebPushOptions } from "./core/push-types.js";
import { runWithSendHooks, type SendHookSlot } from "./core/send-context.js";
import type { VerifyResult } from "./core/types.js";

/** Configuration for {@link createPushSender}. */
export interface PushSenderConfig {
  /** Push delivery transport. */
  transport: PushTransport;
  /** Optional plugins run before each send. */
  plugins?: PushPlugin[];
  /** Optional lifecycle hooks for metrics and tracing. */
  hooks?: PushHooks;
}

/** Push sender returned by {@link createPushSender}. */
export interface PushSender {
  /** Send a push notification through the configured transport. */
  send(options: PushOptions): Promise<PushSendResult>;
  /** Test connectivity and credentials without sending. */
  verify(): Promise<VerifyResult>;
  /** Release resources held by the transport. */
  close(): Promise<void>;
}

async function buildPushHookContext(
  options: PushOptions,
  transport: PushTransport,
): Promise<PushHookContext> {
  let endpoint: string;
  if (isFcmPushOptions(options)) {
    endpoint = await redactFcmToken(options.token);
  } else if (isWebPushOptions(options)) {
    endpoint = await redactPushEndpoint(options.subscription.endpoint);
  } else {
    endpoint = "[unknown-target]";
  }

  return {
    ...(options.messageId !== undefined ? { messageId: options.messageId } : {}),
    endpoint,
    provider: transport.provider ?? "push",
  };
}

/**
 * Create a push sender that wraps a {@link PushTransport}.
 *
 * Pipeline: plugins → onSend → transport.send → onSuccess / onError.
 * `onRetry` / `onFallback` wire when the transport is a retry or fallback decorator.
 */
export function createPushSender(config: PushSenderConfig): PushSender {
  const { transport, plugins, hooks } = config;

  return {
    async send(options: PushOptions): Promise<PushSendResult> {
      const processed = await runPlugins(options, plugins);
      const ctx = await buildPushHookContext(processed, transport);

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
        const successCtx: PushHookContext = {
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
      return { ok: true, provider: "push" };
    },

    async close(): Promise<void> {
      if (transport.close) {
        await transport.close();
      }
    },
  };
}
