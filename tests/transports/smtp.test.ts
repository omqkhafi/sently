import { describe, expect, test } from "bun:test";
import { decodeUtf8 } from "../../src/core/base64.js";
import { SMTPError } from "../../src/core/smtp.js";
import type { SocketAdapter, TLSOptions } from "../../src/core/types.js";
import { openSMTPSession, resolveSMTPConfig, SMTPTransport } from "../../src/transports/smtp.js";

class MockAdapter implements SocketAdapter {
  readonly commands: Uint8Array[] = [];
  private queue: Uint8Array[] = [];
  private readQueue: Uint8Array[][] = [];
  private readIndex = 0;
  _secure = false;
  _connected = false;

  get secure(): boolean {
    return this._secure;
  }

  get connected(): boolean {
    return this._connected;
  }

  setResponses(responses: string[]) {
    this.readQueue = responses.map((r) => [new TextEncoder().encode(r)]);
    this.readIndex = 0;
  }

  async connect(_host: string, _port: number): Promise<void> {
    this._connected = true;
  }

  async startTLS(_options?: TLSOptions): Promise<void> {
    this._secure = true;
  }

  async write(data: Uint8Array): Promise<void> {
    this.commands.push(data);
  }

  async *read(): AsyncIterable<Uint8Array> {
    const chunks = this.readQueue[this.readIndex] ?? [];
    this.readIndex += 1;
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  async close(): Promise<void> {
    this._connected = false;
  }
}

describe("SMTPTransport", () => {
  test("full send sequence with LOGIN auth", async () => {
    const adapter = new MockAdapter();
    adapter.setResponses([
      "220 smtp.example.com ESMTP\r\n",
      "250-smtp.example.com\r\n250-STARTTLS\r\n250 AUTH LOGIN PLAIN\r\n",
      "220 Ready to start TLS\r\n",
      "250-smtp.example.com\r\n250-STARTTLS\r\n250 AUTH LOGIN PLAIN\r\n",
      "334 VXNlcm5hbWU6\r\n",
      "334 UGFzc3dvcmQ6\r\n",
      "235 Authentication successful\r\n",
      "250 Sender OK\r\n",
      "250 Recipient OK\r\n",
      "354 End data with <CR><LF>.<CR><LF>\r\n",
      "250 Message accepted\r\n",
      "221 Bye\r\n",
    ]);

    const transport = new SMTPTransport({
      host: "smtp.example.com",
      port: 587,
      auth: { user: "user", pass: "pass", type: "LOGIN" },
      adapter,
    });

    const result = await transport.send({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Test",
      text: "Hello",
    });

    expect(result.accepted).toEqual(["recipient@example.com"]);
    expect(result.messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/i);

    const dialog = adapter.commands.map((c) => decodeUtf8(c)).join("");
    expect(dialog).toContain("EHLO ");
    expect(dialog).not.toContain("EHLO smtp.example.com");
    expect(dialog).toContain("STARTTLS");
    expect(dialog).toContain("AUTH LOGIN");
    expect(dialog).toContain("MAIL FROM:<sender@example.com>");
    expect(dialog).toContain("RCPT TO:<recipient@example.com>");
    expect(dialog).toContain("DATA");
    expect(dialog).toContain("QUIT");
  });

  test("verify with XOAUTH2 and getToken records AUTH XOAUTH2", async () => {
    const adapter = new MockAdapter();
    adapter.setResponses([
      "220 smtp.example.com ESMTP\r\n",
      "250-smtp.example.com\r\n250 AUTH XOAUTH2 LOGIN PLAIN\r\n",
      "235 Authentication successful\r\n",
      "221 Bye\r\n",
    ]);

    const transport = new SMTPTransport({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      auth: {
        user: "user@example.com",
        type: "OAUTH2",
        oauth2: {
          user: "user@example.com",
          clientId: "id",
          clientSecret: "secret",
          refreshToken: "refresh",
          getToken: async () => "ya29.mock-token",
        },
      },
      adapter,
    });

    await transport.verify();

    const dialog = adapter.commands.map((c) => decodeUtf8(c)).join("");
    expect(dialog).toContain("AUTH XOAUTH2");
    const tokenB64 = dialog.match(/AUTH XOAUTH2 (\S+)/)?.[1] ?? "";
    expect(() => atob(tokenB64)).not.toThrow();
    const decoded = decodeUtf8(Uint8Array.from(atob(tokenB64), (c) => c.charCodeAt(0)));
    expect(decoded).toContain("ya29.mock-token");
  });

  test("requireTLS (default) throws before AUTH on an unencrypted connection", async () => {
    const adapter = new MockAdapter();
    // Server does NOT advertise STARTTLS, so the connection stays cleartext.
    adapter.setResponses([
      "220 smtp.example.com ESMTP\r\n",
      "250-smtp.example.com\r\n250 AUTH LOGIN PLAIN\r\n",
    ]);
    await adapter.connect("smtp.example.com", 587);

    const config = resolveSMTPConfig({
      host: "smtp.example.com",
      port: 587,
      auth: { user: "user", pass: "pass", type: "LOGIN" },
      adapter,
    });

    let thrown: unknown;
    try {
      await openSMTPSession(adapter, config);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(SMTPError);
    expect((thrown as SMTPError).message).toMatch(/unencrypted connection/);

    // AUTH must never be attempted over cleartext.
    const dialog = adapter.commands.map((c) => decodeUtf8(c)).join("");
    expect(dialog).not.toContain("AUTH LOGIN");
  });

  test("requireTLS: false allows AUTH on an unencrypted connection", async () => {
    const adapter = new MockAdapter();
    adapter.setResponses([
      "220 smtp.example.com ESMTP\r\n",
      "250-smtp.example.com\r\n250 AUTH LOGIN PLAIN\r\n",
      "334 VXNlcm5hbWU6\r\n",
      "334 UGFzc3dvcmQ6\r\n",
      "235 Authentication successful\r\n",
    ]);
    await adapter.connect("smtp.example.com", 587);

    const config = resolveSMTPConfig({
      host: "smtp.example.com",
      port: 587,
      requireTLS: false,
      auth: { user: "user", pass: "pass", type: "LOGIN" },
      adapter,
    });

    await openSMTPSession(adapter, config);

    const dialog = adapter.commands.map((c) => decodeUtf8(c)).join("");
    expect(dialog).toContain("AUTH LOGIN");
  });

  test("send with XOAUTH2 auth", async () => {
    const adapter = new MockAdapter();
    adapter.setResponses([
      "220 smtp.example.com ESMTP\r\n",
      "250-smtp.example.com\r\n250 AUTH XOAUTH2 LOGIN PLAIN\r\n",
      "235 Authentication successful\r\n",
      "250 Sender OK\r\n",
      "250 Recipient OK\r\n",
      "354 End data with <CR><LF>.<CR><LF>\r\n",
      "250 Message accepted\r\n",
      "221 Bye\r\n",
    ]);

    const transport = new SMTPTransport({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      auth: {
        user: "me@gmail.com",
        type: "OAUTH2",
        oauth2: {
          user: "me@gmail.com",
          clientId: "id",
          clientSecret: "secret",
          refreshToken: "refresh",
          accessToken: "ya29.oauth-token",
        },
      },
      adapter,
    });

    await transport.send({
      from: "me@gmail.com",
      to: "recipient@example.com",
      subject: "OAuth2 test",
      text: "Hello",
    });

    const dialog = adapter.commands.map((c) => decodeUtf8(c)).join("");
    expect(dialog).toContain("AUTH XOAUTH2");
    const xoauth2Line = dialog.match(/AUTH XOAUTH2 (\S+)/)?.[1] ?? "";
    const decoded = decodeUtf8(
      Uint8Array.from(atob(xoauth2Line), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toContain("ya29.oauth-token");
  });
});
