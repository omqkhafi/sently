import { describe, expect, test } from "bun:test";
import net from "node:net";
import { NodeAdapter } from "../../src/adapters/node.js";
import { SentlyError } from "../../src/core/errors.js";
import { buildMIME } from "../../src/core/mime.js";
import { SMTPError } from "../../src/core/smtp.js";
import { createMailer } from "../../src/mailer.js";
import { SMTPPool } from "../../src/pool/pool.js";
import { SMTPTransport } from "../../src/transports/smtp.js";

interface ScriptedServer {
  port: number;
  transcript: string;
  received: string[];
  close: () => Promise<void>;
}

function listen(
  onSocket: (socket: net.Socket, push: (chunk: string) => void) => void,
): Promise<ScriptedServer> {
  const transcript: string[] = [];
  const received: string[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      transcript.push(chunk.toString("utf8"));
    });
    onSocket(socket, (chunk) => {
      transcript.push(chunk);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("no port");
      }
      resolve({
        port: address.port,
        get transcript() {
          return transcript.join("");
        },
        received,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function replyTo(socket: net.Socket, line: string): void {
  const command = line.trim();
  if (command.startsWith("EHLO") || command.startsWith("HELO")) {
    socket.write("250-localhost\r\n250 AUTH LOGIN PLAIN\r\n");
    return;
  }
  if (command.startsWith("AUTH LOGIN")) {
    socket.write("334 VXNlcm5hbWU6\r\n");
    return;
  }
  if (command.startsWith("MAIL FROM")) {
    socket.write("250 OK\r\n");
    return;
  }
  if (command.startsWith("RCPT TO")) {
    socket.write("250 OK\r\n");
    return;
  }
  if (command === "DATA") {
    socket.write("354 Go\r\n");
    return;
  }
  if (command === "RSET") {
    socket.write("250 Reset\r\n");
    return;
  }
  if (command.startsWith("QUIT")) {
    socket.write("221 Bye\r\n");
    return;
  }
}

describe("SMTP hardening", () => {
  test("auto-selects AUTH LOGIN from a standard EHLO line", async () => {
    let sawAuth = false;
    const server = await listen((socket) => {
      socket.write("220 ready\r\n");
      let buffer = "";
      let authStep = 0;
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\r\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("AUTH LOGIN")) {
            sawAuth = true;
            authStep = 1;
            socket.write("334 VXNlcm5hbWU6\r\n");
            continue;
          }
          if (authStep === 1) {
            authStep = 2;
            socket.write("334 UGFzc3dvcmQ6\r\n");
            continue;
          }
          if (authStep === 2) {
            authStep = 0;
            socket.write("235 OK\r\n");
            continue;
          }
          if (line === ".") {
            socket.write("250 Queued\r\n");
            continue;
          }
          replyTo(socket, line);
        }
      });
    });

    try {
      const transport = new SMTPTransport({
        host: "127.0.0.1",
        port: server.port,
        auth: { user: "user", pass: "secret" },
        requireTLS: false,
        adapter: new NodeAdapter({ connectionTimeout: 2_000 }),
        greetingTimeout: 2_000,
        socketTimeout: 2_000,
        clientName: "client.test",
      });
      const result = await transport.send({
        from: "a@example.com",
        to: "b@example.com",
        subject: "hi",
        text: "body",
      });
      expect(result.accepted).toEqual(["b@example.com"]);
      expect(sawAuth).toBe(true);
      expect(server.transcript).toContain("EHLO client.test");
      expect(server.transcript).not.toContain("EHLO 127.0.0.1");
    } finally {
      await server.close();
    }
  });

  test("greetingTimeout rejects a silent server", async () => {
    const server = await listen(() => {
      // accept and stay silent
    });
    try {
      const transport = new SMTPTransport({
        host: "127.0.0.1",
        port: server.port,
        adapter: new NodeAdapter({ connectionTimeout: 2_000 }),
        greetingTimeout: 200,
        socketTimeout: 200,
      });
      const started = Date.now();
      await expect(
        transport.send({
          from: "a@example.com",
          to: "b@example.com",
          subject: "hi",
          text: "body",
        }),
      ).rejects.toMatchObject({ sentlyCode: "TIMEOUT" });
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      await server.close();
    }
  });

  test("a greeting slower than connectionTimeout still settles", async () => {
    const server = await listen((socket) => {
      setTimeout(() => socket.write("220 late\r\n"), 500);
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (text.startsWith("EHLO")) {
          socket.write("250 localhost\r\n");
        } else if (text.startsWith("MAIL")) {
          socket.write("250 OK\r\n");
        } else if (text.startsWith("RCPT")) {
          socket.write("250 OK\r\n");
        } else if (text.startsWith("DATA")) {
          socket.write("354 Go\r\n");
        } else if (text.includes("\r\n.\r\n")) {
          socket.write("250 Queued\r\n");
        } else if (text.startsWith("QUIT")) {
          socket.write("221 Bye\r\n");
        }
      });
    });
    try {
      const transport = new SMTPTransport({
        host: "127.0.0.1",
        port: server.port,
        adapter: new NodeAdapter({ connectionTimeout: 200 }),
        greetingTimeout: 2_000,
        socketTimeout: 2_000,
      });
      const result = await transport.send({
        from: "a@example.com",
        to: "b@example.com",
        subject: "hi",
        text: "body",
      });
      expect(result.accepted).toEqual(["b@example.com"]);
    } finally {
      await server.close();
    }
  });

  test("required STARTTLS does not send MAIL when the server offers none", async () => {
    const server = await listen((socket) => {
      socket.write("220 ready\r\n");
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (text.startsWith("EHLO")) {
          socket.write("250 localhost\r\n");
        }
      });
    });
    try {
      const transport = new SMTPTransport({
        host: "127.0.0.1",
        port: server.port,
        starttls: "required",
        adapter: new NodeAdapter(),
        greetingTimeout: 1_000,
        socketTimeout: 1_000,
      });
      await expect(
        transport.send({
          from: "a@example.com",
          to: "b@example.com",
          subject: "hi",
          text: "secret",
        }),
      ).rejects.toMatchObject({ sentlyCode: "TLS_FAILED" });
      expect(server.transcript).not.toContain("MAIL FROM");
      expect(server.transcript).not.toContain("secret");
    } finally {
      await server.close();
    }
  });

  test("starttls never stays cleartext", async () => {
    const server = await listen((socket) => {
      socket.write("220 ready\r\n");
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (text.startsWith("EHLO")) {
          socket.write("250-localhost\r\n250 STARTTLS\r\n");
        } else if (text.startsWith("MAIL")) {
          socket.write("250 OK\r\n");
        } else if (text.startsWith("RCPT")) {
          socket.write("250 OK\r\n");
        } else if (text.startsWith("DATA")) {
          socket.write("354 Go\r\n");
        } else if (text.includes("\r\n.\r\n")) {
          socket.write("250 Queued\r\n");
        } else if (text.startsWith("QUIT")) {
          socket.write("221 Bye\r\n");
        }
      });
    });
    try {
      const transport = new SMTPTransport({
        host: "127.0.0.1",
        port: server.port,
        starttls: "never",
        requireTLS: false,
        adapter: new NodeAdapter(),
        greetingTimeout: 1_000,
        socketTimeout: 1_000,
      });
      await transport.send({
        from: "a@example.com",
        to: "b@example.com",
        subject: "hi",
        text: "body",
      });
      expect(server.transcript).not.toContain("STARTTLS");
    } finally {
      await server.close();
    }
  });

  test("all rejected recipients do not send DATA and the next message is delivered", async () => {
    let message = 0;
    const server = await listen((socket) => {
      socket.write("220 ready\r\n");
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        for (const line of text.split("\r\n").filter((part) => part.length > 0)) {
          if (line.startsWith("EHLO")) {
            socket.write("250 localhost\r\n");
          } else if (line.startsWith("MAIL")) {
            socket.write("250 OK\r\n");
          } else if (line.startsWith("RCPT")) {
            message += 1;
            socket.write(message === 1 ? "550 no\r\n" : "250 OK\r\n");
          } else if (line === "DATA") {
            socket.write("354 Go\r\n");
          } else if (line === "RSET") {
            socket.write("250 Reset\r\n");
          } else if (line.startsWith("QUIT")) {
            socket.write("221 Bye\r\n");
          }
        }
        if (text.includes("\r\n.\r\n")) {
          socket.write("250 Queued\r\n");
        }
      });
    });
    try {
      const pool = new SMTPPool(
        {
          host: "127.0.0.1",
          port: server.port,
          maxConnections: 1,
          greetingTimeout: 1_000,
          socketTimeout: 1_000,
        },
        { createAdapter: () => new NodeAdapter() },
      );
      await expect(
        pool.send({
          from: "a@example.com",
          to: "b@example.com",
          subject: "first",
          text: "nope",
        }),
      ).rejects.toMatchObject({ command: "RCPT TO", sentlyCode: "PROVIDER_ERROR" });
      const second = await pool.send({
        from: "a@example.com",
        to: "c@example.com",
        subject: "second",
        text: "yes",
      });
      expect(second.accepted).toEqual(["c@example.com"]);
      expect(server.transcript.includes("RSET") || server.transcript.includes("QUIT")).toBe(true);
      await pool.close();
    } finally {
      await server.close();
    }
  });

  test("concurrent non-pool sends each deliver", async () => {
    let count = 0;
    const server = await listen((socket) => {
      socket.write("220 ready\r\n");
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (text.startsWith("EHLO")) socket.write("250 localhost\r\n");
        else if (text.startsWith("MAIL")) socket.write("250 OK\r\n");
        else if (text.startsWith("RCPT")) socket.write("250 OK\r\n");
        else if (text.startsWith("DATA")) socket.write("354 Go\r\n");
        else if (text.includes("\r\n.\r\n")) {
          count += 1;
          socket.write("250 Queued\r\n");
        } else if (text.startsWith("QUIT")) socket.write("221 Bye\r\n");
      });
    });
    try {
      const mailer = await createMailer({
        transport: new SMTPTransport({
          host: "127.0.0.1",
          port: server.port,
          adapter: new NodeAdapter(),
          greetingTimeout: 1_000,
          socketTimeout: 1_000,
        }),
      });
      const results = await Promise.all(
        ["one", "two", "three"].map((subject) =>
          mailer.send({
            from: "a@example.com",
            to: "b@example.com",
            subject,
            text: subject,
          }),
        ),
      );
      expect(results).toHaveLength(3);
      expect(count).toBe(3);
    } finally {
      await server.close();
    }
  });

  test("SMTPError JSON omits the server response text", () => {
    const error = new SMTPError(
      "Unexpected SMTP response for MAIL FROM",
      550,
      "MAIL FROM",
      "550 user secret-recipient@example.com unknown",
    );
    expect(error.message).not.toContain("secret-recipient");
    expect(JSON.stringify(error)).not.toContain("secret-recipient");
    expect(error.response).toContain("secret-recipient");
    expect(error).toBeInstanceOf(SentlyError);
  });

  test("a long line is quoted-printable instead of raw 8bit", async () => {
    const line = "a".repeat(1200);
    const mime = await buildMIME(
      {
        from: "a@example.com",
        to: "b@example.com",
        subject: "long",
        text: line,
      },
      undefined,
      { allow8BitMime: false },
    );
    const raw = new TextDecoder().decode(mime.raw);
    expect(raw).toContain("Content-Transfer-Encoding: quoted-printable");
    expect(raw).not.toContain(line);
    expect(mime.eightBit).toBe(false);
  });

  test("messageId and attachment contentType with CR are rejected", async () => {
    await expect(
      buildMIME({
        from: "a@example.com",
        to: "b@example.com",
        subject: "x",
        text: "y",
        messageId: "<a@x>\r\nBcc: evil@x.com",
      }),
    ).rejects.toMatchObject({ sentlyCode: "INVALID_CONFIG" });
  });
});
