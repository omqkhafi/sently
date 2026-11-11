/**
 * @module
 * Brevo (formerly Sendinblue) HTTP transport for sently.
 *
 * @example
 * ```ts
 * import { BrevoTransport } from "sently/transports/brevo";
 * import { createMailer } from "sently/mailer";
 *
 * const mailer = await createMailer({
 *   transport: new BrevoTransport({ apiKey: "xkeysib-..." }),
 * });
 * ```
 */

import { extractEmails, parseAddresses } from "../core/address.js";
import { encodeBase64 } from "../core/base64.js";
import { httpStatusToSentlyCode, SentlyError } from "../core/errors.js";
import { providerFetch, readJsonBody } from "../core/http.js";
import type {
  BrevoConfig,
  MailOptions,
  SendResult,
  Transport,
  VerifyResult,
} from "../core/types.js";
import { resolveAttachments } from "./resolve-attachments.js";

/** Error thrown when the Brevo API returns a non-success response. */
export class BrevoError extends SentlyError {
  /** Creates a Brevo API error with status code and error code. */
  constructor(
    message: string,
    public readonly statusCode: number,
    apiCode: string,
  ) {
    super(message, httpStatusToSentlyCode(statusCode), {
      statusCode,
      provider: "brevo",
    });
    this.name = "BrevoError";
    this.code = apiCode;
  }
}

function toAddressObjects(input: MailOptions["to"]): Array<{ email: string; name?: string }> {
  return parseAddresses(input).map((addr) => ({
    email: addr.address,
    ...(addr.name ? { name: addr.name } : {}),
  }));
}

/**
 * Brevo HTTP API transport.
 */
export class BrevoTransport implements Transport {
  readonly provider = "brevo";

  /** Brevo API key used for Authorization. */
  private readonly apiKey: string;

  /** Creates a Brevo transport with the given API key. */
  constructor(config: BrevoConfig) {
    this.apiKey = config.apiKey;
  }

  /** Sends an email via the Brevo HTTP API. */
  async send(options: MailOptions): Promise<SendResult> {
    const attachments = await resolveAttachments(options.attachments);
    const from = parseAddresses(options.from)[0];

    const body: Record<string, unknown> = {
      sender: from
        ? { email: from.address, ...(from.name ? { name: from.name } : {}) }
        : { email: "" },
      to: toAddressObjects(options.to),
      subject: options.subject,
      ...(options.cc ? { cc: toAddressObjects(options.cc) } : {}),
      ...(options.bcc ? { bcc: toAddressObjects(options.bcc) } : {}),
      ...(options.replyTo
        ? {
            replyTo: (() => {
              const reply = parseAddresses(options.replyTo as MailOptions["to"])[0];
              return reply
                ? { email: reply.address, ...(reply.name ? { name: reply.name } : {}) }
                : undefined;
            })(),
          }
        : {}),
      ...(options.html ? { htmlContent: options.html } : {}),
      ...(options.text ? { textContent: options.text } : {}),
      ...(attachments.length > 0
        ? {
            attachment: attachments.map((att) => ({
              name: att.filename,
              content:
                att.content instanceof Uint8Array
                  ? encodeBase64(att.content).replace(/\r\n/g, "")
                  : att.content,
            })),
          }
        : {}),
    };

    const response = await providerFetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const payload = (await readJsonBody(response, "brevo")) as {
      messageId?: string;
      message?: string;
      code?: string;
    };

    if (!response.ok) {
      throw new BrevoError(
        payload.message ?? "Brevo API error",
        response.status,
        payload.code ?? "",
      );
    }

    const toEmails = extractEmails(options.to);
    return {
      messageId: payload.messageId ?? "",
      accepted: toEmails,
      rejected: [],
      response: payload.messageId ?? "sent",
      envelope: {
        from: from?.address ?? "",
        to: toEmails,
      },
    };
  }

  /** Verifies the Brevo API key by fetching account info. */
  async verify(): Promise<VerifyResult> {
    try {
      const response = await providerFetch("https://api.brevo.com/v3/account", {
        headers: {
          "api-key": this.apiKey,
        },
      });

      const payload = (await readJsonBody(response, "brevo")) as {
        companyName?: string;
        message?: string;
      };

      if (!response.ok) {
        return {
          ok: false,
          provider: "brevo",
          message: payload.message ?? `HTTP ${response.status}`,
        };
      }

      return {
        ok: true,
        provider: "brevo",
        ...(payload.companyName ? { message: payload.companyName } : {}),
      };
    } catch (err) {
      return {
        ok: false,
        provider: "brevo",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
