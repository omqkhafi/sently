import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { ResendTransport } from "../../src/transports/resend.js";

function listen(handler: (response: import("node:http").ServerResponse) => void): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer((_request, response) => {
    handler(response);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("no port");
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

const message = {
  from: "a@example.com",
  to: "b@example.com",
  subject: "hi",
  text: "body",
};

describe("provider HTTP bodies", () => {
  test("a server that never responds fails with TIMEOUT", async () => {
    const { server, url } = await listen(() => {
      // leave the socket open
    });
    try {
      const transport = new ResendTransport({ apiKey: "re_test", baseUrl: url, timeoutMs: 200 });
      const started = Date.now();
      await expect(transport.send(message)).rejects.toMatchObject({ sentlyCode: "TIMEOUT" });
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test("an HTML error body throws with the status code", async () => {
    const { server, url } = await listen((response) => {
      response.writeHead(502, { "content-type": "text/html" });
      response.end("<html>down</html>");
    });
    try {
      const transport = new ResendTransport({ apiKey: "re_test", baseUrl: url, timeoutMs: 1_000 });
      await expect(transport.send(message)).rejects.toMatchObject({
        statusCode: 502,
      });
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test("an empty 200 body is a provider error", async () => {
    const { server, url } = await listen((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end();
    });
    try {
      const transport = new ResendTransport({ apiKey: "re_test", baseUrl: url, timeoutMs: 1_000 });
      await expect(transport.send(message)).rejects.toMatchObject({
        sentlyCode: "PROVIDER_ERROR",
      });
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
