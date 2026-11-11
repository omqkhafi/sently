/**
 * @module
 * Taqnyat WhatsApp Business API transport.
 *
 * Follows [Taqnyat WhatsApp](https://dev.taqnyat.sa/en/doc/whatsapp/):
 * `POST https://api.taqnyat.sa/wa/v2/messages/` with Bearer + JSON.
 * Template: `{ to, type: "template", template: { name, language: { code } } }`.
 * Session text: `{ to, type: "text", text: { body } }`.
 *
 * Vendor extras on this class: templates CRUD, opt-in/out, failover send.
 *
 * Sently-first: wire into {@link createWhatsAppSender}.
 *
 * @example
 * ```ts
 * import { createWhatsAppSender } from "sently/whatsapp";
 * import { TaqnyatWhatsAppTransport } from "sently/transports/taqnyat-whatsapp";
 *
 * const transport = new TaqnyatWhatsAppTransport({
 *   bearerToken: process.env.TAQNYAT_WHATSAPP_TOKEN!,
 * });
 * const wa = createWhatsAppSender({ transport });
 * await transport.optIn("+9665xxxxxxxx");
 * await wa.send({ to: "+9665xxxxxxxx", template: { name: "welcome", language: "ar" } });
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
import { normalizeTaqnyatPhone } from "./taqnyat-phone.js";

/** Taqnyat WhatsApp API configuration. */
export interface TaqnyatWhatsAppConfig {
  /** Bearer token from a Taqnyat application enabled for WhatsApp. */
  bearerToken: string;
}

/** One template row from {@link TaqnyatWhatsAppTransport.listTemplates}. */
export interface TaqnyatWhatsAppTemplate {
  /** Template name. */
  name: string;
  /** Language code (e.g. `ar`, `en`). */
  language: string;
  /** Status (`approved`, `pending`, …). */
  status: string;
  /** Category when present (`UTILITY`, `MARKETING`, …). */
  category?: string;
  /** Provider template id when present. */
  id?: string;
}

/** Options for {@link TaqnyatWhatsAppTransport.createTemplate}. */
export interface TaqnyatCreateTemplateOptions {
  /** Unique template name without spaces. */
  name: string;
  /** Language code. */
  language: string;
  /** Template category (`UTILITY`, `MARKETING`, `AUTHENTICATION`, …). */
  category: string;
  /** Component array as required by Taqnyat / Meta. */
  components: unknown[];
  /** Allow Meta to adjust category. Defaults to `true`. */
  allowCategoryChange?: boolean;
}

/** Email fallback nested under SMS/mail failover payloads. */
export interface TaqnyatFailoverEmailOnFail {
  from: string;
  to: string;
}

/** SMS failover branch for {@link TaqnyatWhatsAppTransport.sendWithFailover}. */
export interface TaqnyatWhatsAppSmsFailover {
  sender: string;
  campaign: string;
  body: string;
  sendEmailIfFail?: TaqnyatFailoverEmailOnFail;
}

/** Mail failover branch for {@link TaqnyatWhatsAppTransport.sendWithFailover}. */
export interface TaqnyatWhatsAppMailFailover {
  from: string;
  to: string;
  campaign: string;
  subject: string;
  msg: string;
  cc?: string;
  sendEmailIfFail?: TaqnyatFailoverEmailOnFail;
}

/** Failover channels for {@link TaqnyatWhatsAppTransport.sendWithFailover}. */
export interface TaqnyatWhatsAppFailover {
  sms?: TaqnyatWhatsAppSmsFailover;
  mail?: TaqnyatWhatsAppMailFailover;
}

/** Error thrown when the Taqnyat WhatsApp API reports a failure. */
export class TaqnyatWhatsAppError extends SentlyError {
  /** Creates a Taqnyat WhatsApp API error with status code and response payload. */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly apiError: unknown,
  ) {
    super(
      message,
      httpStatusToSentlyCode(statusCode >= 100 && statusCode < 600 ? statusCode : 400),
      {
        statusCode,
        provider: "taqnyat-whatsapp",
        cause: apiError,
      },
    );
    this.name = "TaqnyatWhatsAppError";
  }
}

function isTemplateMessage(
  options: WhatsAppOptions,
): options is Extract<WhatsAppOptions, { template: unknown }> {
  return "template" in options;
}

function extractMessageId(payload: Record<string, unknown>): string | undefined {
  const statuses = payload.statuses;
  if (Array.isArray(statuses)) {
    const first = statuses[0] as Record<string, unknown> | undefined;
    if (typeof first?.message_id === "string") return first.message_id;
  } else if (statuses && typeof statuses === "object") {
    const direct = (statuses as Record<string, unknown>).message_id;
    if (typeof direct === "string") return direct;
    for (const value of Object.values(statuses as Record<string, unknown>)) {
      if (value && typeof value === "object") {
        const id = (value as Record<string, unknown>).message_id;
        if (typeof id === "string") return id;
      }
    }
  }
  return undefined;
}

/** Docs sometimes return `statuses: "PENDING"` (queued) with no message_id yet. */
function isQueuedAcceptance(payload: Record<string, unknown>): boolean {
  return (
    payload.statuses === "PENDING" ||
    (typeof payload.type === "string" &&
      (payload.type === "template" || payload.type === "text") &&
      payload.message === undefined)
  );
}

function describeWhatsAppResponse(payload: Record<string, unknown>): string {
  if (typeof payload.statuses === "string") return payload.statuses;
  if (typeof payload.type === "string") return payload.type;
  return "Message sent";
}

function throwWhatsAppError(response: Response, payload: Record<string, unknown>): never {
  const reason =
    typeof payload.reason === "string"
      ? payload.reason
      : typeof payload.message === "string"
        ? `Taqnyat WhatsApp error ${payload.message}`
        : "Taqnyat WhatsApp API error";
  const status =
    typeof payload.message === "string" && /^\d+$/.test(payload.message)
      ? Number(payload.message)
      : response.status;
  throw new TaqnyatWhatsAppError(reason, status || response.status, payload);
}

function buildMessageBody(options: WhatsAppOptions): Record<string, unknown> {
  const to = normalizeTaqnyatPhone(options.to);
  return isTemplateMessage(options)
    ? {
        to,
        type: "template" as const,
        template: {
          name: options.template.name,
          language: { code: options.template.language },
          ...(options.template.components ? { components: options.template.components } : {}),
        },
      }
    : {
        to,
        type: "text" as const,
        text: { body: options.text },
      };
}

function normalizeNumbers(to: string | readonly string[]): string[] {
  const list = typeof to === "string" ? [to] : [...to];
  return list.map(normalizeTaqnyatPhone);
}

/**
 * Taqnyat WhatsApp transport via JSON Bearer `wa/v2/messages/`.
 */
export class TaqnyatWhatsAppTransport implements WhatsAppTransport {
  readonly provider = "taqnyat-whatsapp";

  private readonly bearerToken: string;

  /** Creates a Taqnyat WhatsApp transport. */
  constructor(config: TaqnyatWhatsAppConfig) {
    this.bearerToken = config.bearerToken;
  }

  /** Sends a WhatsApp template or session text message. */
  async send(options: WhatsAppOptions): Promise<WhatsAppSendResult> {
    return this.postMessage(buildMessageBody(options), options);
  }

  /**
   * Vendor extra: send with optional SMS / email failover branches
   * (same `POST /wa/v2/messages/` payload shape as Taqnyat failover docs).
   * Not part of {@link WhatsAppTransport}.
   */
  async sendWithFailover(
    options: WhatsAppOptions,
    failover: TaqnyatWhatsAppFailover,
  ): Promise<WhatsAppSendResult> {
    const body: Record<string, unknown> = buildMessageBody(options);
    if (failover.sms) {
      body.sms = {
        sender: failover.sms.sender,
        campaign: failover.sms.campaign,
        body: failover.sms.body,
        ...(failover.sms.sendEmailIfFail ? { sendEmailIfFail: failover.sms.sendEmailIfFail } : {}),
      };
    }
    if (failover.mail) {
      body.mail = {
        from: failover.mail.from,
        to: failover.mail.to,
        campaign: failover.mail.campaign,
        subject: failover.mail.subject,
        msg: failover.mail.msg,
        ...(failover.mail.cc !== undefined ? { cc: failover.mail.cc } : {}),
        ...(failover.mail.sendEmailIfFail
          ? { sendEmailIfFail: failover.mail.sendEmailIfFail }
          : {}),
      };
    }
    return this.postMessage(body, options);
  }

  /**
   * Vendor extra: list templates via `GET /wa/v2/templates/`.
   * Not part of {@link WhatsAppTransport}.
   */
  async listTemplates(): Promise<TaqnyatWhatsAppTemplate[]> {
    const response = await providerFetch("https://api.taqnyat.sa/wa/v2/templates/?limit=5000", {
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        Accept: "application/json",
      },
    });
    const payload = (await readJsonBody(response, "taqnyat-whatsapp")) as {
      waba_templates?: Array<Record<string, unknown>>;
      message?: string;
      reason?: string;
    };

    if (!response.ok || !Array.isArray(payload.waba_templates)) {
      throwWhatsAppError(response, payload as Record<string, unknown>);
    }

    return payload.waba_templates.map((row) => ({
      name: String(row.name ?? ""),
      language: String(row.language ?? ""),
      status: String(row.status ?? ""),
      ...(typeof row.category === "string" ? { category: row.category } : {}),
      ...(row.id !== undefined ? { id: String(row.id) } : {}),
    }));
  }

  /**
   * Vendor extra: create a template via `POST /wa/v2/templates/`.
   * Not part of {@link WhatsAppTransport}.
   */
  async createTemplate(
    options: TaqnyatCreateTemplateOptions,
  ): Promise<{ id?: string; category?: string; status: string; provider: "taqnyat-whatsapp" }> {
    const response = await providerFetch("https://api.taqnyat.sa/wa/v2/templates/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: options.name,
        language: options.language,
        allow_category_change: options.allowCategoryChange ?? true,
        category: options.category,
        components: options.components,
      }),
    });
    const payload = (await readJsonBody(response, "taqnyat-whatsapp")) as Record<string, unknown>;
    const status =
      typeof payload.statuses === "string"
        ? payload.statuses
        : typeof payload.status === "string"
          ? payload.status
          : undefined;

    if (!response.ok || (payload.message !== undefined && status === undefined)) {
      throwWhatsAppError(response, payload);
    }

    return {
      ...(payload.id !== undefined ? { id: String(payload.id) } : {}),
      ...(typeof payload.category === "string" ? { category: payload.category } : {}),
      status: status ?? "PENDING",
      provider: "taqnyat-whatsapp",
    };
  }

  /**
   * Vendor extra: delete a template via `DELETE /wa/v2/templates/`.
   * Not part of {@link WhatsAppTransport}.
   */
  async deleteTemplate(options: {
    name: string;
    id: string | number;
  }): Promise<{ ok: true; provider: "taqnyat-whatsapp" }> {
    const response = await providerFetch("https://api.taqnyat.sa/wa/v2/templates/", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: options.name, id: options.id }),
    });
    const payload = (await readJsonBody(response, "taqnyat-whatsapp")) as Record<string, unknown>;
    const ok =
      response.ok &&
      (payload.message === "201" || payload.reason === "success" || payload.message === undefined);

    if (!ok) {
      throwWhatsAppError(response, payload);
    }

    return { ok: true, provider: "taqnyat-whatsapp" };
  }

  /**
   * Vendor extra: record WhatsApp opt-in via `POST /wa/v1/provision/optin/`.
   * Not part of {@link WhatsAppTransport}.
   */
  async optIn(
    to: string | readonly string[],
  ): Promise<{ ok: true; numbers: string[]; provider: "taqnyat-whatsapp" }> {
    return this.postOptProvision("POST", to);
  }

  /**
   * Vendor extra: record WhatsApp opt-out via `DELETE /wa/v1/provision/optin/`.
   * Not part of {@link WhatsAppTransport}.
   */
  async optOut(
    to: string | readonly string[],
  ): Promise<{ ok: true; numbers: string[]; provider: "taqnyat-whatsapp" }> {
    return this.postOptProvision("DELETE", to);
  }

  /** Lightweight credential check. */
  async verify(): Promise<VerifyResult> {
    return {
      ok: Boolean(this.bearerToken),
      provider: "taqnyat-whatsapp",
      message: this.bearerToken ? "Credentials present" : "Missing credentials",
    };
  }

  private async postMessage(
    body: Record<string, unknown>,
    options: WhatsAppOptions,
  ): Promise<WhatsAppSendResult> {
    const response = await providerFetch("https://api.taqnyat.sa/wa/v2/messages/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const payload = (await readJsonBody(response, "taqnyat-whatsapp")) as Record<string, unknown>;
    const messageId = extractMessageId(payload);
    const queued = isQueuedAcceptance(payload);

    if (!response.ok || (payload.message !== undefined && messageId === undefined && !queued)) {
      throwWhatsAppError(response, payload);
    }

    return {
      messageId: messageId ?? options.messageId ?? "",
      to: options.to,
      status: "accepted",
      response: describeWhatsAppResponse(payload),
      provider: "taqnyat-whatsapp",
    };
  }

  private async postOptProvision(
    method: "POST" | "DELETE",
    to: string | readonly string[],
  ): Promise<{ ok: true; numbers: string[]; provider: "taqnyat-whatsapp" }> {
    const numbers = normalizeNumbers(to);
    const response = await providerFetch("https://api.taqnyat.sa/wa/v1/provision/optin/", {
      method,
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ numbers }),
    });
    const payload = (await readJsonBody(response, "taqnyat-whatsapp")) as Record<string, unknown>;
    // Success: `{ type: "Opt-In"|"Opt-Out", statuses: [...] }`. Errors use `message` + `reason`.
    const looksOk = typeof payload.type === "string" && payload.statuses !== undefined;
    if (!looksOk) {
      throwWhatsAppError(response, payload);
    }

    return { ok: true, numbers, provider: "taqnyat-whatsapp" };
  }
}
