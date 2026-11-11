/**
 * @module
 * Node.js socket adapter for SMTP connections via node:net and node:tls.
 *
 * @example
 * ```ts
 * import { NodeAdapter } from "sently/adapters/node";
 * import { createSMTPMailer } from "sently/smtp";
 *
 * const mailer = await createSMTPMailer({
 *   host: "smtp.example.com",
 *   adapter: new NodeAdapter(),
 *   auth: { user: "you@example.com", pass: "secret" },
 * });
 * ```
 */
import { NodeCompatSocket, type NodeCompatSocketOptions } from "./node-socket.js";

/** Configuration options for {@link NodeAdapter}. */
export type NodeAdapterOptions = NodeCompatSocketOptions;

/**
 * Node.js socket adapter using node:net and node:tls.
 */
export class NodeAdapter extends NodeCompatSocket {
  /** Creates a Node.js socket adapter. */
  constructor(options: NodeAdapterOptions = {}) {
    super(options);
  }
}
