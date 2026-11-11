import { describe, expect, test } from "bun:test";
import { encodeBase64, encodeUtf8 } from "../../src/core/base64.js";
import {
  canonicalizeBodyRelaxed,
  canonicalizeHeadersRelaxed,
  importPrivateKey,
  signDKIM,
} from "../../src/core/dkim.js";

describe("canonicalizeBodyRelaxed", () => {
  test("keeps a leading empty line and strips only trailing empty lines", () => {
    const body = "  \r\n A  \r\n \t B  \r\n C  \r\n\r\n";
    const canonical = canonicalizeBodyRelaxed(body);
    expect(canonical).toBe("\r\n A\r\n B\r\n C\r\n");
  });

  test("keeps an empty line in the middle of the body", () => {
    expect(canonicalizeBodyRelaxed("foo  \r\n\r\nbar \t\r\n\r\n\r\n")).toBe("foo\r\n\r\nbar\r\n");
  });

  test("empty body ends with CRLF", () => {
    expect(canonicalizeBodyRelaxed("")).toBe("\r\n");
  });
});

describe("canonicalizeHeadersRelaxed", () => {
  test("lowercases and unfolds headers", () => {
    const headers = "From: John Doe <john@example.com>\r\nTo: Jane\r\n";
    const result = canonicalizeHeadersRelaxed(headers, ["from", "to"]);
    expect(result).toBe("from:John Doe <john@example.com>\r\nto:Jane\r\n");
  });
});

describe("importPrivateKey", () => {
  test("rejects OpenSSH Ed25519 PEM with conversion instructions", async () => {
    const opensshPem = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
    await expect(importPrivateKey(opensshPem, "ed25519-sha256")).rejects.toThrow(
      /PKCS#8.*openssl pkcs8/s,
    );
  });
});

function derToPem(der: ArrayBuffer, label: string): string {
  const b64 = encodeBase64(new Uint8Array(der)).replace(/\r\n/g, "");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

describe("signDKIM", () => {
  test("RSA-SHA256 sign and verify round-trip", async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );

    const privateDer = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
    const publicDer = await crypto.subtle.exportKey("spki", pair.publicKey);
    const privatePem = derToPem(privateDer, "PRIVATE KEY");

    const raw = encodeUtf8(
      "From: sender@example.com\r\nTo: recv@example.com\r\nSubject: Test\r\n\r\nHello\r\n",
    );

    const { header } = await signDKIM(raw, {
      domainName: "example.com",
      keySelector: "test",
      privateKey: privatePem,
      headerFieldNames: "from:to:subject",
    });

    expect(header.startsWith("DKIM-Signature:")).toBe(true);
    expect(header).toContain("d=example.com");
    expect(header).toContain("b=");

    const bMatch = header.match(/b=([^;]+)/);
    expect(bMatch).not.toBeNull();
    const sigB64 = (bMatch?.[1] ?? "").trim();
    const sigBytes = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));

    const publicKey = await crypto.subtle.importKey(
      "spki",
      new Uint8Array(publicDer),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const dkimValue = header.replace(/^DKIM-Signature:\s*/i, "");
    const emptyB = dkimValue.replace(/b=[^;]+/, "b=");
    const headerBlock = new TextDecoder().decode(raw);
    const sep = headerBlock.indexOf("\r\n\r\n");
    const headersOnly = sep >= 0 ? headerBlock.slice(0, sep) : headerBlock;
    const withDkim = `${headersOnly}\r\ndkim-signature:${emptyB}`;
    const canonicalForVerify = canonicalizeHeadersRelaxed(withDkim, [
      "from",
      "to",
      "subject",
      "dkim-signature",
    ]);

    const valid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      publicKey,
      sigBytes,
      encodeUtf8(canonicalForVerify),
    );
    expect(valid).toBe(true);
  });

  test("Ed25519 round-trip via generateKey pkcs8 PEM and importPrivateKey", async () => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const privateDer = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
    const publicDer = await crypto.subtle.exportKey("spki", pair.publicKey);
    const privatePem = derToPem(privateDer, "PRIVATE KEY");

    const imported = await importPrivateKey(privatePem, "ed25519-sha256");
    const message = encodeUtf8("dkim-ed25519-signing-payload");
    const signature = await crypto.subtle.sign("Ed25519", imported, message);

    const publicKey = await crypto.subtle.importKey("spki", new Uint8Array(publicDer), "Ed25519", false, [
      "verify",
    ]);
    const valid = await crypto.subtle.verify("Ed25519", publicKey, signature, message);
    expect(valid).toBe(true);
  });

  test("Ed25519-SHA256 sign and verify round-trip", async () => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const privateDer = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
    const publicDer = await crypto.subtle.exportKey("spki", pair.publicKey);
    const privatePem = derToPem(privateDer, "PRIVATE KEY");

    const raw = encodeUtf8("From: a@b.com\r\nSubject: Hi\r\n\r\nBody\r\n");
    const { header } = await signDKIM(raw, {
      domainName: "example.com",
      keySelector: "ed",
      privateKey: privatePem,
      algorithm: "ed25519-sha256",
      headerFieldNames: "from:subject",
    });

    expect(header).toContain("a=ed25519-sha256");

    const bMatch = header.match(/b=([^;]+)/);
    const sigBytes = Uint8Array.from(atob((bMatch?.[1] ?? "").trim()), (c) => c.charCodeAt(0));
    const publicKey = await crypto.subtle.importKey("spki", new Uint8Array(publicDer), "Ed25519", false, [
      "verify",
    ]);

    const dkimValue = header.replace(/^DKIM-Signature:\s*/i, "");
    const emptyB = dkimValue.replace(/b=[^;]*/, "b=");
    const withDkim = `From: a@b.com\r\nSubject: Hi\r\ndkim-signature:${emptyB}`;
    const canonical = canonicalizeHeadersRelaxed(withDkim, ["from", "subject", "dkim-signature"]);

    const valid = await crypto.subtle.verify("Ed25519", publicKey, sigBytes, encodeUtf8(canonical));
    expect(valid).toBe(true);
  });

  test("DKIM-Signature header format", async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const privatePem = derToPem(await crypto.subtle.exportKey("pkcs8", pair.privateKey), "PRIVATE KEY");
    const raw = encodeUtf8("From: x@y.com\r\nSubject: S\r\n\r\nHi\r\n");

    const { header } = await signDKIM(raw, {
      domainName: "example.com",
      keySelector: "sel",
      privateKey: privatePem,
      algorithm: "rsa-sha256",
      headerFieldNames: "from:subject",
    });

    expect(header.startsWith("DKIM-Signature:")).toBe(true);
    expect(header).toContain("v=1;");
    expect(header).toContain("a=rsa-sha256;");
    const bValue = header.match(/b=([^;]+)/)?.[1]?.trim() ?? "";
    expect(bValue.length).toBeGreaterThan(0);
  });

  test("body hash bh= is stable", async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const privatePem = derToPem(await crypto.subtle.exportKey("pkcs8", pair.privateKey), "PRIVATE KEY");
    const raw = encodeUtf8("From: a@b.com\r\n\r\n  hello  \r\n");
    const { header } = await signDKIM(raw, {
      domainName: "example.com",
      keySelector: "s",
      privateKey: privatePem,
      headerFieldNames: "from",
    });
    const bh1 = header.match(/bh=([^;]+)/)?.[1];
    const { header: header2 } = await signDKIM(raw, {
      domainName: "example.com",
      keySelector: "s",
      privateKey: privatePem,
      headerFieldNames: "from",
    });
    const bh2 = header2.match(/bh=([^;]+)/)?.[1];
    expect(bh1).toBe(bh2);
    expect(bh1?.length).toBeGreaterThan(0);
  });
});
