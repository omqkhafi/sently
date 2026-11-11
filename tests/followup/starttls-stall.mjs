/**
 * Node and plain-Bun regression for a STARTTLS stall.
 * `bun test` can pass while `send()` never settles, so this file is not a bun test.
 * It imports the built mailer and must exit 0 on its own.
 *
 * Covers a direct mailer and a pooled mailer. Each case runs several times.
 */
import net from "node:net";
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
