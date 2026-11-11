/**
 * @module
 * Meta WhatsApp Cloud API transport.
 *
 * Sently-first: wire into {@link createWhatsAppSender}. Other WhatsApp providers
 * (e.g. `TaqnyatWhatsAppTransport`) are separate transports with the same contract.
 *
 * @example
 * ```ts
 * import { createWhatsAppSender } from "sently/whatsapp";
 * import { WhatsAppCloudTransport } from "sently/transports/whatsapp-cloud";
 *
 * const wa = createWhatsAppSender({
 *   transport: new WhatsAppCloudTransport({
 *     accessToken: process.env.WHATSAPP_TOKEN!,
 *     phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
 *   }),
 * });
 * ```
 */

import { httpStatusToSentlyCode, SentlyError } from "../core/errors.js";
import { providerFetch, readJsonBody } from "../core/http.js";
import type { VerifyResult } from "../core/types.js";
import type {
  WhatsAppOptions,
  WhatsAppSendResult,
  WhatsAppTransport,
} from "../core/whatsapp-types.js";

/** Default Graph API version (current as of 2026-08). */
export const WHATSAPP_CLOUD_DEFAULT_API_VERSION = "v26.0";

/** WhatsApp Cloud API configuration. */
export interface WhatsAppCloudConfig {
  /** Meta Graph API access token. */
  accessToken: string;
  /** WhatsApp Business phone number ID. */
  phoneNumberId: string;
  /** Graph API version (e.g. `"v26.0"`). Default: {@link WHATSAPP_CLOUD_DEFAULT_API_VERSION}. */
  apiVersion?: string;
}

/** Error thrown when the WhatsApp Cloud API returns a non-success response. */
export class WhatsAppCloudError extends SentlyError {
  /** Creates a WhatsApp Cloud API error with status code and response payload. */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly apiError: unknown,
  ) {
    super(message, httpStatusToSentlyCode(statusCode), {
      statusCode,
      provider: "whatsapp-cloud",
      cause: apiError,
    });
    this.name = "WhatsAppCloudError";
  }
}

function isTemplateMessage(
  options: WhatsAppOptions,
): options is Extract<WhatsAppOptions, { template: unknown }> {
  return "template" in options;
}

/**
 * WhatsApp Cloud API transport (JSON Bearer).
 */
export class WhatsAppCloudTransport implements WhatsAppTransport {
  readonly provider = "whatsapp-cloud";

  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly apiVersion: string;

  /** Creates a WhatsApp Cloud API transport. */
  constructor(config: WhatsAppCloudConfig) {
    this.accessToken = config.accessToken;
    this.phoneNumberId = config.phoneNumberId;
    this.apiVersion = config.apiVersion ?? WHATSAPP_CLOUD_DEFAULT_API_VERSION;
  }

  /** Sends a WhatsApp template or text message. */
  async send(options: WhatsAppOptions): Promise<WhatsAppSendResult> {
    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;

    const body = isTemplateMessage(options)
      ? {
          messaging_product: "whatsapp",
          to: options.to,
          type: "template",
          template: {
            name: options.template.name,
            language: { code: options.template.language },
            ...(options.template.components ? { components: options.template.components } : {}),
          },
        }
      : {
          messaging_product: "whatsapp",
          to: options.to,
          type: "text",
          text: { body: options.text },
        };

    const response = await providerFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const payload = (await readJsonBody(response, "whatsapp-cloud")) as {
      messages?: Array<{ id?: string }>;
      error?: {
        message?: string;
        code?: number;
        error_subcode?: number;
        fbtrace_id?: string;
      };
    };

    if (!response.ok) {
      throw new WhatsAppCloudError(
        payload.error?.message ?? "WhatsApp Cloud API error",
        response.status,
        payload,
      );
    }

    const id = payload.messages?.[0]?.id ?? options.messageId ?? "";

    return {
      messageId: id,
      to: options.to,
      status: "accepted",
      response: "Message sent",
      provider: "whatsapp-cloud",
    };
  }

  /** Lightweight credential check. */
  async verify(): Promise<VerifyResult> {
    return {
      ok: Boolean(this.accessToken && this.phoneNumberId),
      provider: "whatsapp-cloud",
      message:
        this.accessToken && this.phoneNumberId ? "Credentials present" : "Missing credentials",
    };
  }
}
