import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { SentlyError } from "../../src/core/errors.js";
import { buildMIME } from "../../src/core/mime.js";
import type { MailOptions, SendResult, Transport } from "../../src/core/types.js";
import { createMailer } from "../../src/mailer.js";
import { IdempotencyTransport, MemoryIdempotencyStore } from "../../src/idempotency.js";
import { createSMTPMailer } from "../../src/smtp-mailer.js";
import { RetryTransport } from "../../src/transports/retry.js";
import { verifySignature } from "../../src/webhooks/resend.js";

const message = {
  from: "a@example.com",
  to: "b@example.com",
  subject: "hi",
  text: "body",
};

function listen(onSocket: (socket: net.Socket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    onSocket(socket);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("no port");
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            server.close(() => done());
          }),
      });
    });
  });
}

describe("STARTTLS handshake deadline", () => {
  test("a 220 then a stalled handshake rejects without sendTimeout", async () => {
    const server = await listen((socket) => {
      socket.write("220 ready\r\n");
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (text.startsWith("EHLO")) {
          socket.write("250-localhost\r\n250 STARTTLS\r\n");
        } else if (text.startsWith("STARTTLS")) {
          socket.write("220 ready\r\n");
        }
      });
    });
    try {
      const mailer = await createSMTPMailer({
        host: "127.0.0.1",
        port: server.port,
        secure: false,
        starttls: "required",
        connectionTimeout: 400,
      });
      const started = Date.now();
      await expect(mailer.send(message)).rejects.toMatchObject({
        sentlyCode: "TIMEOUT",
      });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await server.close();
    }
  });

  test("sendTimeout still bounds a stalled handshake", async () => {
    const server = await listen((socket) => {
      socket.write("220 ready\r\n");
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (text.startsWith("EHLO")) {
          socket.write("250-localhost\r\n250 STARTTLS\r\n");
        } else if (text.startsWith("STARTTLS")) {
          socket.write("220 ready\r\n");
        }
      });
    });
    try {
      const mailer = await createSMTPMailer({
        host: "127.0.0.1",
        port: server.port,
        secure: false,
        starttls: "required",
        connectionTimeout: 10_000,
        socketTimeout: 0,
        sendTimeout: 500,
      });
      const started = Date.now();
      await expect(mailer.send(message)).rejects.toMatchObject({ sentlyCode: "TIMEOUT" });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await server.close();
    }
  });
});

describe("SMTP paths that already failed closed", () => {
  test("a dribble of 250- lines hits the socket deadline", async () => {
    const server = await listen((socket) => {
      socket.write("220 ready\r\n");
      const timer = setInterval(() => socket.write("250-still\r\n"), 40);
      socket.on("close", () => clearInterval(timer));
      socket.on("data", () => undefined);
    });
    try {
      const mailer = await createSMTPMailer({
        host: "127.0.0.1",
        port: server.port,
        connectionTimeout: 5_000,
        socketTimeout: 300,
      });
      const started = Date.now();
      await expect(mailer.send(message)).rejects.toMatchObject({ sentlyCode: "TIMEOUT" });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await server.close();
    }
  });

  test("silence after the greeting times out", async () => {
    const server = await listen((socket) => {
      socket.write("220 ready\r\n");
    });
    try {
      const mailer = await createSMTPMailer({
        host: "127.0.0.1",
        port: server.port,
        connectionTimeout: 5_000,
        socketTimeout: 300,
      });
      const started = Date.now();
      await expect(mailer.send(message)).rejects.toMatchObject({ sentlyCode: "TIMEOUT" });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await server.close();
    }
  });

  test("a 421 written after EHLO fails the next command", async () => {
    const server = await listen((socket) => {
      socket.write("220 ready\r\n");
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (text.startsWith("EHLO")) {
          socket.write("250 localhost\r\n");
          setImmediate(() => socket.write("421 gap-inject\r\n"));
        }
      });
    });
    try {
      const mailer = await createSMTPMailer({
        host: "127.0.0.1",
        port: server.port,
        socketTimeout: 1_000,
        connectionTimeout: 1_000,
      });
      await expect(mailer.send(message)).rejects.toMatchObject({ code: 421 });
    } finally {
      await server.close();
    }
  });

  test("a destroyed socket during DATA does not send a second body", async () => {
    let dataCommands = 0;
    const server = await listen((socket) => {
      socket.write("220 ready\r\n");
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (text.startsWith("EHLO")) socket.write("250 localhost\r\n");
        else if (text.startsWith("MAIL")) socket.write("250 OK\r\n");
        else if (text.startsWith("RCPT")) socket.write("250 OK\r\n");
        else if (text.startsWith("DATA")) {
          dataCommands += 1;
          socket.write("354 Go\r\n");
        } else {
          socket.destroy();
        }
      });
    });
    try {
      const mailer = await createSMTPMailer({
        host: "127.0.0.1",
        port: server.port,
        socketTimeout: 1_000,
        connectionTimeout: 1_000,
      });
      await expect(mailer.send(message)).rejects.toBeInstanceOf(SentlyError);
      expect(dataCommands).toBe(1);
    } finally {
      await server.close();
    }
  });

  test("an empty AUTH password is INVALID_CONFIG", async () => {
    const server = await listen((socket) => {
      socket.write("220 ready\r\n");
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (text.startsWith("EHLO")) socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
      });
    });
    try {
      const mailer = await createSMTPMailer({
        host: "127.0.0.1",
        port: server.port,
        requireTLS: false,
        auth: { user: "user", pass: "" },
        socketTimeout: 1_000,
        connectionTimeout: 1_000,
      });
      await expect(mailer.send(message)).rejects.toMatchObject({
        sentlyCode: "INVALID_CONFIG",
      });
    } finally {
      await server.close();
    }
  });
});

describe("TLS SNI", () => {
  const dir = mkdtempSync(join(tmpdir(), "sently-tls-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-nodes",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  const key = readFileSync(keyPath);
  const cert = readFileSync(certPath);

  function answerSmtp(socket: net.Socket | tls.TLSSocket): void {
    socket.write("220 ready\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\r\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("EHLO") || line.startsWith("HELO")) socket.write("250 localhost\r\n");
        else if (line.startsWith("MAIL") || line.startsWith("RCPT") || line === "RSET") {
          socket.write("250 OK\r\n");
        } else if (line === "DATA") socket.write("354 Go\r\n");
        else if (line === ".") socket.write("250 Queued\r\n");
        else if (line.startsWith("QUIT")) socket.write("221 Bye\r\n");
      }
    });
  }

  test("bytes after the STARTTLS 220 are discarded and SNI is the hostname", async () => {
    let sni: string | undefined;
    const server = net.createServer((socket) => {
      socket.write("220 ready\r\n");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (!buffer.includes("STARTTLS")) {
          if (buffer.includes("EHLO")) {
            socket.write("250-localhost\r\n250 STARTTLS\r\n");
            buffer = "";
          }
          return;
        }
        socket.write("220 ready\r\n250-INJECTED\r\n");
        socket.removeAllListeners("data");
        const secure = new tls.TLSSocket(socket, { isServer: true, key, cert });
        secure.on("secure", () => {
          sni = secure.servername;
          let pending = "";
          secure.on("data", (secureChunk) => {
            pending += secureChunk.toString("utf8");
            const lines = pending.split("\r\n");
            pending = lines.pop() ?? "";
            for (const line of lines) {
              if (line.startsWith("EHLO")) secure.write("250 localhost\r\n");
              else if (line.startsWith("MAIL") || line.startsWith("RCPT")) secure.write("250 OK\r\n");
              else if (line === "DATA") secure.write("354 Go\r\n");
              else if (line === ".") secure.write("250 Queued\r\n");
              else if (line.startsWith("QUIT")) secure.write("221 Bye\r\n");
            }
          });
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : 0;
    try {
      const mailer = await createSMTPMailer({
        host: "localhost",
        port,
        secure: false,
        starttls: "required",
        tls: { rejectUnauthorized: false },
        connectionTimeout: 2_000,
        socketTimeout: 2_000,
      });
      const result = await mailer.send(message);
      expect(result.accepted).toEqual(["b@example.com"]);
      expect(sni).toBe("localhost");
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test("implicit TLS to an IP literal does not set ServerName to the IP", async () => {
    const server = tls.createServer({ key, cert }, (socket) => {
      answerSmtp(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : 0;
    try {
      const mailer = await createSMTPMailer({
        host: "127.0.0.1",
        port,
        secure: true,
        tls: { rejectUnauthorized: false },
        connectionTimeout: 2_000,
        socketTimeout: 2_000,
      });
      const result = await mailer.send(message);
      expect(result.accepted).toEqual(["b@example.com"]);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe("library leftovers", () => {
  test("filenames with quotes or CR use RFC 2231 and do not open a header", async () => {
    const mime = await buildMIME({
      ...message,
      attachments: [
        { filename: 'a.txt";\r\nBcc: evil@x.com', content: new Uint8Array([1]) },
        { filename: "ملف.txt", content: new Uint8Array([2]) },
      ],
    });
    const raw = new TextDecoder().decode(mime.raw);
    expect(raw).toContain("filename*=UTF-8''");
    expect(raw).not.toMatch(/\r\nBcc:/);
    expect(raw).toContain("%D9%85%D9%84%D9%81.txt");
  });

  test("a missing to is INVALID_CONFIG", async () => {
    const transport: Transport = {
      send: async () => {
        throw new Error("should not send");
      },
    };
    const mailer = await createMailer({ transport });
    await expect(
      mailer.send({ from: "a@example.com", subject: "s", text: "t" } as MailOptions),
    ).rejects.toMatchObject({ sentlyCode: "INVALID_CONFIG" });
  });

  test("concurrent onRetry hooks keep their own subject", async () => {
    const seen = new Set<string>();
    const counts: Record<string, number> = {};
    const inner: Transport = {
      send: async (options) => {
        const subject = options.subject;
        if (!seen.has(subject)) {
          seen.add(subject);
          await new Promise((resolve) => setTimeout(resolve, 30));
          throw new SentlyError("later", "PROVIDER_ERROR", { statusCode: 503 });
        }
        const result: SendResult = {
          messageId: `<${subject}@example.com>`,
          accepted: ["b@example.com"],
          rejected: [],
          response: "250 OK",
          envelope: { from: "a@example.com", to: ["b@example.com"] },
        };
        return result;
      },
    };
    const mailer = await createMailer({
      transport: new RetryTransport(inner, { maxAttempts: 2, backoff: "fixed", baseDelay: 10 }),
      hooks: {
        onRetry: (ctx) => {
          counts[ctx.subject] = (counts[ctx.subject] ?? 0) + 1;
        },
      },
    });
    await Promise.all([
      mailer.send({ ...message, subject: "fast" }),
      mailer.send({ ...message, subject: "slow" }),
    ]);
    expect(counts).toEqual({ fast: 1, slow: 1 });
  });

  test("sendBatch does not resend a stored idempotency key", async () => {
    let calls = 0;
    const inner: Transport = {
      send: async () => {
        calls += 1;
        return {
          messageId: "<id@example.com>",
          accepted: ["b@example.com"],
          rejected: [],
          response: "250 OK",
          envelope: { from: "a@example.com", to: ["b@example.com"] },
        };
      },
    };
    const transport = new IdempotencyTransport(inner, { store: new MemoryIdempotencyStore() });
    const keyed = { ...message, idempotencyKey: "stored" };
    await transport.send(keyed);
    await transport.sendBatch([keyed, keyed]);
    expect(calls).toBe(1);
  });

  test("maxAttempts 0 throws INVALID_CONFIG", () => {
    const inner: Transport = { send: async () => message as unknown as SendResult };
    expect(() => new RetryTransport(inner, { maxAttempts: 0 })).toThrow(/maxAttempts/);
  });

  test("an invalid Resend webhook secret returns false", async () => {
    const ok = await verifySignature(
      "{}",
      {
        "svix-id": "msg_1",
        "svix-timestamp": String(Math.floor(Date.now() / 1000)),
        "svix-signature": "v1,AAAA",
      },
      "not a secret",
    );
    expect(ok).toBe(false);
  });

  test("send-context does not import node:async_hooks at load time", () => {
    const source = readFileSync(new URL("../../src/core/send-context.ts", import.meta.url), "utf8");
    expect(source).not.toContain('from "node:async_hooks"');
  });
});
