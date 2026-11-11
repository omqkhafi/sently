/**
 * Node and plain-Bun regression for a STARTTLS stall.
 * `bun test` can pass while `send()` never settles, so this file is not a bun test.
 * It imports the built mailer and must exit 0 on its own.
 */
import net from "node:net";
import { createSMTPMailer } from "../../dist/smtp-mailer.js";

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

const started = Date.now();
const watchdog = setTimeout(() => {
  console.error("send() did not settle");
  process.exit(1);
}, 2_000);

let failed = false;
try {
  const mailer = await createSMTPMailer({
    host: "127.0.0.1",
    port,
    secure: false,
    starttls: "required",
    connectionTimeout: 400,
  });
  await mailer.send({
    from: "a@example.com",
    to: "b@example.com",
    subject: "hi",
    text: "body",
  });
  console.error("send() resolved");
  failed = true;
} catch (error) {
  const elapsed = Date.now() - started;
  const code =
    error && typeof error === "object" && "sentlyCode" in error ? error.sentlyCode : undefined;
  if (code !== "TIMEOUT" || elapsed >= 2_000) {
    console.error("expected TIMEOUT from send()", code, `${elapsed}ms`, error);
    failed = true;
  } else {
    console.log(`TIMEOUT ${elapsed}ms`);
  }
}

clearTimeout(watchdog);
for (const socket of sockets) {
  socket.destroy();
}
await new Promise((resolve) => {
  server.close(() => resolve());
});

if (failed) {
  process.exit(1);
}

const leak = setTimeout(() => {
  console.error("process did not exit after send() settled");
  process.exit(1);
}, 500);
leak.unref();
