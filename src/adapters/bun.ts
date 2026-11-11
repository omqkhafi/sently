/**
 * @module
 * Bun socket adapter for SMTP connections via the Node.js compatibility layer.
 *
 * @example
 * ```ts
 * import { BunAdapter } from "sently/adapters/bun";
 * import { createSMTPMailer } from "sently/smtp";
 *
 * const mailer = await createSMTPMailer({
 *   host: "smtp.example.com",
 *   adapter: new BunAdapter(),
 *   auth: { user: "you@example.com", pass: "secret" },
 * });
 * ```
 */
import { NodeCompatSocket, type NodeCompatSocketOptions } from "./node-socket.js";

declare const Bun: { version: string } | undefined;

/** Configuration options for {@link BunAdapter}. */
export type BunAdapterOptions = NodeCompatSocketOptions;

/**
 * Bun socket adapter using node:net and node:tls (Node compat layer).
 */
export class BunAdapter extends NodeCompatSocket {
  /** Creates a Bun socket adapter (requires the Bun runtime). */
  constructor(options: BunAdapterOptions = {}) {
    if (typeof Bun === "undefined") {
      throw new Error("BunAdapter requires the Bun runtime");
    }
    super(options);
  }
}
