/**
 * @module
 * Postmark HTTP API transport for sending email via api.postmarkapp.com.
 *
 * @example
 * ```ts
 * import { PostmarkTransport } from "sently/transports/postmark";
 * import { createMailer } from "sently/mailer";
 *
 * const mailer = await createMailer({
 *   transport: new PostmarkTransport({ serverToken: process.env.POSTMARK_TOKEN! }),
 * });
 *
 * await mailer.send({
 *   from: "sender@example.com",
 *   to: "recipient@example.com",
 *   subject: "Hello",
 *   text: "Plain text body",
 * });
 * ```
 */

import { extractEmails, parseAddresses, toMIMEHeader } from "../core/address.js";
import { encodeBase64 } from "../core/base64.js";
import { httpStatusToSentlyCode, SentlyError } from "../core/errors.js";
import { providerFetch, readJsonBody } from "../core/http.js";
import type { MailOptions, SendResult, Transport, VerifyResult } from "../core/types.js";
import { resolveAttachments } from "./resolve-attachments.js";

/** Postmark API configuration. */
export interface PostmarkConfig {
  /** Postmark server API token. */
  serverToken: string;
}

/** Error thrown when the Postmark API returns a non-success response. */
export class PostmarkError extends SentlyError {
  /** Creates a Postmark API error with status code and response payload. */
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly apiError: unknown,
  ) {
    super(message, httpStatusToSentlyCode(statusCode), {
      statusCode,
      provider: "postmark",
      cause: apiError,
    });
    this.name = "PostmarkError";
  }
}

/**
 * Postmark HTTP API transport.
 */
export class PostmarkTransport implements Transport {
  readonly provider = "postmark";

  /** Postmark server API token for the X-Postmark-Server-Token header. */
  private readonly serverToken: string;

  /** Creates a Postmark transport with the given server token. */
  constructor(config: PostmarkConfig) {
    this.serverToken = config.serverToken;
  }

  /** Sends an email via the Postmark HTTP API. */
  async send(options: MailOptions): Promise<SendResult> {
    const attachments = await resolveAttachments(options.attachments);
    const from = parseAddresses(options.from)[0];

    const body = {
      From: from ? toMIMEHeader(from) : "",
      To: parseAddresses(options.to).map(toMIMEHeader).join(", "),
      Subject: options.subject,
      ...(options.cc ? { Cc: parseAddresses(options.cc).map(toMIMEHeader).join(", ") } : {}),
      ...(options.bcc ? { Bcc: parseAddresses(options.bcc).map(toMIMEHeader).join(", ") } : {}),
      ...(options.replyTo
        ? { ReplyTo: parseAddresses(options.replyTo).map(toMIMEHeader).join(", ") }
        : {}),
      ...(options.text ? { TextBody: options.text } : {}),
      ...(options.html ? { HtmlBody: options.html } : {}),
      ...(options.headers
        ? { Headers: Object.entries(options.headers).map(([Name, Value]) => ({ Name, Value })) }
        : {}),
      ...(attachments.length > 0
        ? {
            Attachments: attachments.map((att) => ({
              Name: att.filename,
              Content:
                att.content instanceof Uint8Array
                  ? encodeBase64(att.content).replace(/\r\n/g, "")
                  : att.content,
              ContentType: att.contentType ?? "application/octet-stream",
              ...(att.contentId ? { ContentID: att.contentId } : {}),
            })),
          }
        : {}),
    };

    const response = await providerFetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "X-Postmark-Server-Token": this.serverToken,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    const payload = (await readJsonBody(response, "postmark")) as {
      MessageID?: string;
      Message?: string;
      ErrorCode?: number;
    };

    if (!response.ok) {
      throw new PostmarkError(payload.Message ?? "Postmark API error", response.status, payload);
    }

    return {
      messageId: payload.MessageID ?? options.messageId ?? "",
      accepted: extractEmails(options.to),
      rejected: [],
      response: payload.Message ?? "OK",
      envelope: {
        from: from?.address ?? "",
        to: [
          ...extractEmails(options.to),
          ...(options.cc ? extractEmails(options.cc) : []),
          ...(options.bcc ? extractEmails(options.bcc) : []),
        ],
      },
    };
  }

  /** Verifies the Postmark server token by fetching server info. */
  async verify(): Promise<VerifyResult> {
    try {
      const response = await providerFetch("https://api.postmarkapp.com/server", {
        headers: {
          "X-Postmark-Server-Token": this.serverToken,
          Accept: "application/json",
        },
      });

      const payload = (await readJsonBody(response, "postmark")) as {
        Name?: string;
        Message?: string;
      };

      if (!response.ok) {
        return {
          ok: false,
          provider: "postmark",
          message: payload.Message ?? `HTTP ${response.status}`,
        };
      }

      return {
        ok: true,
        provider: "postmark",
        ...(payload.Name ? { message: payload.Name } : {}),
      };
    } catch (err) {
      return {
        ok: false,
        provider: "postmark",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
