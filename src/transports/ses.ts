/**
 * @module
 * AWS SES v2 HTTP transport for sently.
 * Signs requests with AWS Signature Version 4 using Web Crypto.
 * Works on Node.js, Bun, Deno, and Cloudflare Workers.
 *
 * @example
 * ```ts
 * import { SESTransport } from "sently/transports/ses";
 * import { createMailer } from "sently/mailer";
 *
 * const mailer = await createMailer({
 *   transport: new SESTransport({
 *     accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
 *     secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
 *     region: "us-east-1",
 *   }),
 * });
 * ```
 */

import { extractEmails, parseAddresses, toMIMEHeader } from "../core/address.js";
import { encodeBase64 } from "../core/base64.js";
import { httpStatusToSentlyCode, SentlyError } from "../core/errors.js";
import { providerFetch, readJsonBody } from "../core/http.js";
import { buildMIME } from "../core/mime.js";
import { signRequest } from "../core/sigv4.js";
import type { MailOptions, SESConfig, SendResult, Transport, VerifyResult } from "../core/types.js";
import { resolveAttachments } from "./resolve-attachments.js";

/** Error thrown when the AWS SES API returns a non-success response. */
export class SESError extends SentlyError {
  /** Creates an AWS SES API error with status code, error code, and request ID. */
  constructor(
    message: string,
    public readonly statusCode: number,
    awsCode: string,
    public readonly requestId: string,
  ) {
    super(message, httpStatusToSentlyCode(statusCode), {
      statusCode,
      provider: "ses",
    });
    this.name = "SESError";
    this.code = awsCode;
  }
}

/**
 * AWS SES v2 HTTP API transport.
 */
export class SESTransport implements Transport {
  readonly provider = "ses";

  /** AWS access key ID for SigV4 signing. */
  private readonly accessKeyId: string;
  /** AWS secret access key for SigV4 signing. */
  private readonly secretAccessKey: string;
  /** AWS region for the SES endpoint. */
  private readonly region: string;
  /** Optional STS session token for temporary credentials. */
  private readonly sessionToken: string | undefined;
  /** Optional DKIM config for raw MIME attachment sends. */
  private readonly dkim: SESConfig["dkim"];

  /** Creates an SES transport with AWS credentials. */
  constructor(config: SESConfig) {
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
    this.region = config.region ?? "us-east-1";
    this.sessionToken = config.sessionToken;
    this.dkim = config.dkim;
  }

  /** Sends an email via the AWS SES v2 HTTP API. */
  async send(options: MailOptions): Promise<SendResult> {
    const attachments = await resolveAttachments(options.attachments);
    const resolvedOptions = { ...options, attachments };
    const from = parseAddresses(options.from)[0];
    const fromEmail = from ? toMIMEHeader(from) : "";
    const toEmails = extractEmails(options.to);
    const ccEmails = options.cc ? extractEmails(options.cc) : [];
    const bccEmails = options.bcc ? extractEmails(options.bcc) : [];

    const destination = {
      ToAddresses: toEmails,
      CcAddresses: ccEmails,
      BccAddresses: bccEmails,
    };

    let requestBody: Record<string, unknown>;

    if (attachments.length > 0) {
      const mime = await buildMIME(resolvedOptions, this.dkim);
      requestBody = {
        FromEmailAddress: fromEmail,
        Destination: destination,
        Content: {
          Raw: {
            Data: encodeBase64(mime.raw).replace(/\r\n/g, ""),
          },
        },
      };
    } else {
      requestBody = {
        FromEmailAddress: fromEmail,
        Destination: destination,
        Content: {
          Simple: {
            Subject: { Data: options.subject, Charset: "UTF-8" },
            Body: {
              ...(options.text ? { Text: { Data: options.text, Charset: "UTF-8" } } : {}),
              ...(options.html ? { Html: { Data: options.html, Charset: "UTF-8" } } : {}),
            },
          },
        },
      };
    }

    const body = JSON.stringify(requestBody);
    const url = `https://email.${this.region}.amazonaws.com/v2/email/outbound-emails`;
    const signed = await signRequest({
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
      },
      body,
      credentials: {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
        region: this.region,
        service: "ses",
        ...(this.sessionToken ? { sessionToken: this.sessionToken } : {}),
      },
    });

    const response = await providerFetch(url, {
      method: "POST",
      headers: signed.headers,
      body,
    });

    const payload = (await readJsonBody(response, "ses")) as {
      MessageId?: string;
      message?: string;
      Code?: string;
    };

    if (!response.ok) {
      throw new SESError(
        payload.message ?? "SES API error",
        response.status,
        payload.Code ?? "",
        response.headers.get("x-amzn-requestid") ?? "",
      );
    }

    const messageId = payload.MessageId ?? "";
    return {
      messageId,
      accepted: [...toEmails, ...ccEmails, ...bccEmails],
      rejected: [],
      response: `MessageId: ${messageId}`,
      envelope: {
        from: from?.address ?? "",
        to: toEmails,
      },
    };
  }

  /** Verifies AWS credentials by listing SES configuration sets. */
  async verify(): Promise<VerifyResult> {
    try {
      const url = `https://email.${this.region}.amazonaws.com/v2/email/configuration-sets`;
      const signed = await signRequest({
        method: "GET",
        url,
        headers: {},
        body: "",
        credentials: {
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey,
          region: this.region,
          service: "ses",
          ...(this.sessionToken ? { sessionToken: this.sessionToken } : {}),
        },
      });

      const response = await providerFetch(url, {
        method: "GET",
        headers: signed.headers,
      });

      const payload = (await response.json().catch(() => ({}))) as { message?: string };

      if (!response.ok) {
        return {
          ok: false,
          provider: "ses",
          message: payload.message ?? `HTTP ${response.status}`,
        };
      }

      return { ok: true, provider: "ses", message: "Credentials are valid" };
    } catch (err) {
      return {
        ok: false,
        provider: "ses",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
