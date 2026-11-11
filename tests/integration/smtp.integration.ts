/**
 * SMTP / Mailpit integration test (localhost:1025 + API :8025).
 * Run locally with: docker run -p 1025:1025 -p 8025:8025 axllent/mailpit
 * Run in CI via the services block in test.yml.
 *
 * Usage: bun run tests/integration/smtp.integration.ts
 */
import { createMailer, createSMTPMailer } from "../../src/index.js";
import { MailpitTransport } from "../../src/transports/mailpit.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Integration test failed: ${message}`);
  }
}

// Test 1: MailpitTransport plain text + REST list
const mailpit = new MailpitTransport();
const mailer = await createMailer({ transport: mailpit });
await mailpit.deleteAll();

await mailer.send({
  from: "sender@test.com",
  to: "recipient@test.com",
  subject: "Integration test — plain text",
  text: "Hello from sently integration test",
});

const msgs = await mailpit.messages();
assert(msgs.total >= 1, "At least one message received");
assert(msgs.messages[0]?.Subject === "Integration test — plain text");
assert(msgs.messages[0]?.To[0]?.Address === "recipient@test.com");

const full = await mailpit.getMessage(msgs.messages[0]!.ID);
assert(full.Text.includes("Hello from sently"), "Full message body readable");

// Test 2: HTML email with attachment
await mailer.send({
  from: "sender@test.com",
  to: "recipient@test.com",
  subject: "Integration test — HTML",
  html: "<h1>Hello</h1>",
  text: "Hello",
  attachments: [
    {
      filename: "test.txt",
      content: new TextEncoder().encode("attachment content"),
      contentType: "text/plain",
    },
  ],
});

const msgs2 = await mailpit.messages();
const htmlMsg = msgs2.messages.find((m) => m.Subject === "Integration test — HTML");
assert(Boolean(htmlMsg), "HTML message received");
assert(htmlMsg?.Attachments === 1, "Attachment present");

// Test 3: createSMTPMailer still works against Mailpit
const smtpMailer = await createSMTPMailer({ host: "localhost", port: 1025 });
await smtpMailer.send({
  from: "smtp@test.com",
  to: "recipient@test.com",
  subject: "Integration test — createSMTPMailer",
  text: "ok",
});

// Test 4: Connection pool
const poolMailer = await createSMTPMailer({
  host: "localhost",
  port: 1025,
  pool: true,
  maxConnections: 2,
});
await Promise.all([
  poolMailer.send({ from: "a@test.com", to: "b@test.com", subject: "Pool 1", text: "ok" }),
  poolMailer.send({ from: "a@test.com", to: "b@test.com", subject: "Pool 2", text: "ok" }),
]);
await poolMailer.close();
await mailer.close();

console.log("✓ All integration tests passed");
