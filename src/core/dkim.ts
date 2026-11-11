/**
 * DKIM signing implementation (RFC 6376). Public entry: `sently/dkim`.
 */
import { encodeBase64, encodeUtf8 } from "./base64.js";
import type { DKIMConfig } from "./types.js";

const CRLF = "\r\n";
const DEFAULT_HEADER_FIELDS = "from:to:subject:date:message-id:mime-version:content-type";

/** Result of DKIM signing — the header line to prepend. */
export interface DKIMSignResult {
  /** Complete DKIM-Signature header line (without trailing CRLF). */
  header: string;
}

/**
 * Canonicalize headers using the relaxed algorithm (RFC 6376 §3.4.2).
 */
export function canonicalizeHeadersRelaxed(headers: string, fieldNames: string[]): string {
  const parsed = parseHeaders(headers);
  const lines: string[] = [];

  for (const name of fieldNames) {
    const key = name.toLowerCase().trim();
    const values = parsed.get(key);
    if (!values) {
      continue;
    }
    for (const value of values) {
      const unfolded = value.replace(/\r?\n/g, "").replace(/\s+/g, " ").trim();
      lines.push(`${key}:${unfolded}`);
    }
  }

  return lines.length > 0 ? `${lines.join(CRLF)}${CRLF}` : "";
}

/**
 * Canonicalize body using the relaxed algorithm (RFC 6376 §3.4.4).
 */
export function canonicalizeBodyRelaxed(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/g, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    return CRLF;
  }
  return `${lines.join(CRLF)}${CRLF}`;
}

/**
 * Import a PEM-encoded private key into a Web Crypto CryptoKey.
 */
export async function importPrivateKey(
  pem: string,
  algorithm: "rsa-sha256" | "ed25519-sha256",
): Promise<CryptoKey> {
  if (algorithm === "ed25519-sha256" && /OPENSSH PRIVATE KEY/i.test(pem)) {
    throw new Error(
      "Ed25519 keys must be in PKCS#8 PEM format (-----BEGIN PRIVATE KEY-----). Convert with: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key_pkcs8.pem",
    );
  }

  const der = pemToDer(pem);

  const derBuffer = toArrayBuffer(der);

  try {
    if (algorithm === "ed25519-sha256") {
      return await crypto.subtle.importKey("pkcs8", derBuffer, { name: "Ed25519" }, false, [
        "sign",
      ]);
    }
    return await crypto.subtle.importKey(
      "pkcs8",
      derBuffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (err) {
    if (algorithm === "ed25519-sha256" && err instanceof DOMException) {
      throw new Error("Ed25519 DKIM requires Node.js ≥ 18.4, Bun ≥ 1.0, or Cloudflare Workers", {
        cause: err,
      });
    }
    throw err;
  }
}

/**
 * Sign a raw MIME message with DKIM.
 */
export async function signDKIM(
  rawMessage: Uint8Array,
  config: DKIMConfig,
): Promise<DKIMSignResult> {
  const algorithm = config.algorithm ?? "rsa-sha256";
  const fieldList = (config.headerFieldNames ?? DEFAULT_HEADER_FIELDS)
    .split(":")
    .map((f) => f.trim().toLowerCase())
    .filter(Boolean);
  const skip = new Set(
    (config.skipFields ?? "")
      .split(":")
      .map((f) => f.trim().toLowerCase())
      .filter(Boolean),
  );
  const signFields = fieldList.filter((f) => !skip.has(f));

  const text = new TextDecoder().decode(rawMessage);
  const sep = text.indexOf("\r\n\r\n");
  const headerPart = sep >= 0 ? text.slice(0, sep) : text;
  const bodyPart = sep >= 0 ? text.slice(sep + 4) : "";

  const bodyCanonical = canonicalizeBodyRelaxed(bodyPart);
  const bodyHash = await sha256Base64(encodeUtf8(bodyCanonical));

  const dkimAlgo = algorithm === "ed25519-sha256" ? "ed25519-sha256" : "rsa-sha256";
  const headerList = signFields.join(":");
  const timestamp = Math.floor(Date.now() / 1000);

  const dkimWithoutSig = [
    `v=1`,
    `a=${dkimAlgo}`,
    `c=relaxed/relaxed`,
    `d=${config.domainName}`,
    `s=${config.keySelector}`,
    `h=${headerList}`,
    `bh=${bodyHash}`,
    `b=`,
    `t=${timestamp}`,
  ].join("; ");

  const dkimHeaderName = "dkim-signature";
  const dkimHeaderValue = dkimWithoutSig;
  const headersWithDkim = `${headerPart}${CRLF}${dkimHeaderName}:${dkimHeaderValue}`;
  const canonical = canonicalizeHeadersRelaxed(headersWithDkim, [...signFields, dkimHeaderName]);

  const key = await importPrivateKey(config.privateKey, algorithm);
  const data = encodeUtf8(canonical);
  const signature = await signData(key, data, algorithm);
  const bValue = encodeBase64(signature).replace(/\r\n/g, "");

  const header = `DKIM-Signature: v=1; a=${dkimAlgo}; c=relaxed/relaxed; d=${config.domainName}; s=${config.keySelector}; h=${headerList}; bh=${bodyHash}; b=${bValue}; t=${timestamp}`;

  return { header };
}

function parseHeaders(headerBlock: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const lines = headerBlock.split(/\r?\n/).filter((l) => l.length > 0);
  let currentName = "";
  let currentValue = "";

  const flush = (): void => {
    if (!currentName) {
      return;
    }
    const key = currentName.toLowerCase();
    const list = map.get(key) ?? [];
    list.push(currentValue);
    map.set(key, list);
    currentName = "";
    currentValue = "";
  };

  for (const line of lines) {
    if (/^[ \t]/.test(line) && currentName) {
      currentValue += ` ${line.trim()}`;
      continue;
    }
    flush();
    const colon = line.indexOf(":");
    if (colon > 0) {
      currentName = line.slice(0, colon).trim();
      currentValue = line.slice(colon + 1).trim();
    }
  }
  flush();
  return map;
}

function pemToDer(pem: string): Uint8Array {
  const lines = pem
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(lines);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    der[i] = binary.charCodeAt(i);
  }
  return der;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256Base64(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", toArrayBuffer(data));
  return encodeBase64(new Uint8Array(hash)).replace(/\r\n/g, "");
}

async function signData(
  key: CryptoKey,
  data: Uint8Array,
  algorithm: "rsa-sha256" | "ed25519-sha256",
): Promise<Uint8Array> {
  const buf = toArrayBuffer(data);
  if (algorithm === "ed25519-sha256") {
    const sig = await crypto.subtle.sign("Ed25519", key, buf);
    return new Uint8Array(sig);
  }
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, buf);
  return new Uint8Array(sig);
}
