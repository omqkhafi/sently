/**
 * Node and plain-Bun regression for a STARTTLS stall.
 * `bun test` can pass while `send()` never settles, so this file is not a bun test.
 * It imports the built mailer and must exit 0 on its own.
 *
 * Covers a direct mailer and a pooled mailer. Each case runs several times.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { createSMTPMailer } from "../../dist/smtp-mailer.js";

const iterations = 10;
const message = {
  from: "a@example.com",
  to: "b@example.com",
  subject: "hi",
  text: "body",
};

const sockets = [];
const server = net.createServer((socket) => {
  sockets.push(socket);
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

const port = await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      reject(new Error("no port"));
      return;
    }
    resolve(address.port);
  });
});

/**
 * @param {boolean} pool
 * @param {number} attempt
 */
async function sendWithTimeout(attempt) {
  const started = Date.now();
  const watchdog = setTimeout(() => {
    console.error(`pool-sendTimeout send() did not settle (attempt ${attempt})`);
    process.exit(1);
  }, 2_000);
  const mailer = await createSMTPMailer({
    host: "127.0.0.1",
    port,
    secure: false,
    starttls: "required",
    pool: true,
    connectionTimeout: 0,
    socketTimeout: 0,
    sendTimeout: 500,
  });
  try {
    await mailer.send(message);
    console.error(`pool-sendTimeout send() resolved (attempt ${attempt})`);
    process.exit(1);
  } catch (error) {
    const elapsed = Date.now() - started;
    const code =
      error && typeof error === "object" && "sentlyCode" in error ? error.sentlyCode : undefined;
    if (code !== "TIMEOUT" || elapsed >= 2_000) {
      console.error("pool-sendTimeout expected TIMEOUT", code, `${elapsed}ms`, error);
      process.exit(1);
    }
    console.log(`pool-sendTimeout TIMEOUT ${elapsed}ms`);
  } finally {
    clearTimeout(watchdog);
    await mailer.close();
  }
}

async function recoverPooledSend() {
  const dir = mkdtempSync(join(tmpdir(), "sently-stall-"));
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
  let stall = true;
  const recoverySockets = [];
  const recovery = net.createServer((socket) => {
    recoverySockets.push(socket);
    socket.write("220 ready\r\n");
    let stalled = false;
    socket.on("data", (chunk) => {
      if (stalled) {
        return;
      }
      const text = chunk.toString("utf8");
      if (text.startsWith("EHLO")) {
        socket.write("250-localhost\r\n250 STARTTLS\r\n");
        return;
      }
      if (!text.startsWith("STARTTLS")) {
        return;
      }
      socket.write("220 ready\r\n");
      if (stall) {
        stalled = true;
        return;
      }
      socket.removeAllListeners("data");
      const secure = new tls.TLSSocket(socket, { isServer: true, key, cert });
      recoverySockets.push(secure);
      secure.on("secure", () => {
        let pending = "";
        secure.on("data", (secureChunk) => {
          pending += secureChunk.toString("utf8");
          const lines = pending.split("\r\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("EHLO") || line.startsWith("HELO")) secure.write("250 localhost\r\n");
            else if (line.startsWith("MAIL") || line.startsWith("RCPT")) secure.write("250 OK\r\n");
            else if (line === "DATA") secure.write("354 Go\r\n");
            else if (line === ".") secure.write("250 Queued\r\n");
            else if (line.startsWith("QUIT")) secure.write("221 Bye\r\n");
          }
        });
      });
    });
  });
  const recoveryPort = await new Promise((resolve, reject) => {
    recovery.once("error", reject);
    recovery.listen(0, "127.0.0.1", () => {
      const address = recovery.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve(address.port);
    });
  });
  const mailer = await createSMTPMailer({
    host: "127.0.0.1",
    port: recoveryPort,
    secure: false,
    starttls: "required",
    pool: true,
    connectionTimeout: 0,
    socketTimeout: 0,
    sendTimeout: 500,
    tls: { rejectUnauthorized: false },
  });
  const watchdog = setTimeout(() => {
    console.error("pooled sendTimeout recovery did not settle");
    process.exit(1);
  }, 2_000);
  try {
    await mailer.send(message);
    console.error("pooled sendTimeout recovery send() resolved");
    process.exit(1);
  } catch (error) {
    const code =
      error && typeof error === "object" && "sentlyCode" in error ? error.sentlyCode : undefined;
    if (code !== "TIMEOUT") {
      console.error("pooled sendTimeout recovery expected TIMEOUT", error);
      process.exit(1);
    }
  }
  stall = false;
  clearTimeout(watchdog);
  const started = Date.now();
  const result = await mailer.send(message);
  if (!result.accepted || result.accepted[0] !== "b@example.com") {
    console.error("pooled send did not recover", result);
    process.exit(1);
  }
  if (Date.now() - started >= 2_000) {
    console.error("pooled recovery send was too slow");
    process.exit(1);
  }
  console.log("pool-sendTimeout recovered");
  await mailer.close();
  for (const socket of recoverySockets) {
    socket.destroy();
  }
  await new Promise((resolve) => recovery.close(() => resolve()));
}

async function sendOnce(pool, attempt) {
  const started = Date.now();
  const label = pool ? "pool" : "direct";
  const watchdog = setTimeout(() => {
    console.error(`${label} send() did not settle (attempt ${attempt})`);
    process.exit(1);
  }, 2_000);
  const mailer = await createSMTPMailer({
    host: "127.0.0.1",
    port,
    secure: false,
    starttls: "required",
    connectionTimeout: 400,
    ...(pool ? { pool: true } : {}),
  });
  try {
    await mailer.send(message);
    console.error(`${label} send() resolved (attempt ${attempt})`);
    process.exit(1);
  } catch (error) {
    const elapsed = Date.now() - started;
    const code =
      error && typeof error === "object" && "sentlyCode" in error ? error.sentlyCode : undefined;
    if (code !== "TIMEOUT" || elapsed >= 2_000) {
      console.error(`${label} expected TIMEOUT`, code, `${elapsed}ms`, error);
      process.exit(1);
    }
    console.log(`${label} TIMEOUT ${elapsed}ms`);
  } finally {
    clearTimeout(watchdog);
    await mailer.close();
  }
}

for (let attempt = 1; attempt <= iterations; attempt++) {
  await sendOnce(false, attempt);
}
for (let attempt = 1; attempt <= iterations; attempt++) {
  await sendOnce(true, attempt);
}
for (let attempt = 1; attempt <= iterations; attempt++) {
  await sendWithTimeout(attempt);
}
await recoverPooledSend();

for (const socket of sockets) {
  socket.destroy();
}
await new Promise((resolve) => {
  server.close(() => resolve());
});

const leak = setTimeout(() => {
  console.error("process did not exit after send() settled");
  process.exit(1);
}, 500);
leak.unref();
