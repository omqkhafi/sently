import { describe, expect, test } from "bun:test";
import { verifySignature as verifyMailgunSignature } from "../../src/webhooks/mailgun.js";
import { verifySignature as verifyResendSignature } from "../../src/webhooks/resend.js";
import { verifySignature as verifySndrSignature } from "../../src/webhooks/sndr.js";
import { decodeBase64Bytes, timingSafeEqual } from "../../src/webhooks/timing-safe-equal.js";

describe("timingSafeEqual", () => {
  test("returns true for identical bytes", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  test("returns false when only the last byte differs", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  test("returns false on length mismatch without throwing", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

async function signMailgunHex(
  timestamp: string,
  token: string,
  signingKey: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(timestamp + token),
  );
  return [...new Uint8Array(expected)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signResendBase64(
  payload: string,
  secret: string,
  msgId: string,
  timestamp: string,
): Promise<string> {
  const encoded = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const binary = atob(encoded);
  const keyBytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    keyBytes[i] = binary.charCodeAt(i);
  }

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signedContent = `${msgId}.${timestamp}.${payload}`;
  const expected = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
  return btoa(String.fromCharCode(...new Uint8Array(expected)));
}

describe("verifyMailgunSignature", () => {
  test("accepts a valid signature and rejects a last-byte tamper", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const token = "test-token";
    const signingKey = "test-signing-key";
    const signature = await signMailgunHex(timestamp, token, signingKey);

    expect(await verifyMailgunSignature(timestamp, token, signature, signingKey)).toBe(true);

    const tampered = signature.slice(0, -1) + (signature.endsWith("a") ? "b" : "a");
    expect(await verifyMailgunSignature(timestamp, token, tampered, signingKey)).toBe(false);
  });

  test("returns false on length mismatch without throwing", async () => {
    const signature = await signMailgunHex("1", "token", "key");
    await expect(verifyMailgunSignature("1", "token", `${signature}ff`, "key")).resolves.toBe(
      false,
    );
  });
});

describe("verifyResendSignature", () => {
  test("accepts a valid signature and rejects a last-byte tamper", async () => {
    const payload = '{"type":"email.delivered"}';
    const secret = `whsec_${btoa("super-secret-key-for-test!!")}`;
    const msgId = "msg_123";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await signResendBase64(payload, secret, msgId, timestamp);

    expect(
      await verifyResendSignature(
        payload,
        {
          "svix-id": msgId,
          "svix-timestamp": timestamp,
          "svix-signature": `v1,${signature}`,
        },
        secret,
      ),
    ).toBe(true);

    const sigBytes = decodeBase64Bytes(signature)!;
    sigBytes[sigBytes.length - 1] ^= 0xff;
    const tampered = btoa(String.fromCharCode(...sigBytes));

    expect(
      await verifyResendSignature(
        payload,
        {
          "svix-id": msgId,
          "svix-timestamp": timestamp,
          "svix-signature": `v1,${tampered}`,
        },
        secret,
      ),
    ).toBe(false);
  });

  test("returns false on length mismatch without throwing", async () => {
    const payload = "{}";
    const secret = `whsec_${btoa("another-test-secret-key!!!!")}`;
    const msgId = "msg_456";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await signResendBase64(payload, secret, msgId, timestamp);

    await expect(
      verifyResendSignature(
        payload,
        {
          "svix-id": msgId,
          "svix-timestamp": timestamp,
          "svix-signature": `v1,${signature}=`,
        },
        secret,
      ),
    ).resolves.toBe(false);
  });
});

async function signSndrHex(rawBody: string, secret: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  return [...new Uint8Array(expected)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("verifySndrSignature", () => {
  test("accepts a valid signature and rejects a last-byte tamper", async () => {
    const payload = '{"type":"email.delivered"}';
    const secret = "sndr_whsec_test_secret";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const v1 = await signSndrHex(payload, secret, timestamp);

    expect(await verifySndrSignature(payload, `t=${timestamp},v1=${v1}`, secret)).toBe(true);

    const tampered = v1.slice(0, -1) + (v1.endsWith("a") ? "b" : "a");
    expect(await verifySndrSignature(payload, `t=${timestamp},v1=${tampered}`, secret)).toBe(false);
  });

  test("rejects stale timestamps by default", async () => {
    const payload = "{}";
    const secret = "sndr_whsec_test_secret";
    const timestamp = "1000000000";
    const v1 = await signSndrHex(payload, secret, timestamp);

    expect(await verifySndrSignature(payload, `t=${timestamp},v1=${v1}`, secret)).toBe(false);
    expect(
      await verifySndrSignature(payload, `t=${timestamp},v1=${v1}`, secret, {
        toleranceSeconds: 0,
      }),
    ).toBe(true);
  });
});
