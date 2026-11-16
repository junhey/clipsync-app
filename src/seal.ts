/**
 * Client-side seal for private shares.
 * Keep this in lockstep with docs/pages/seal.js:
 * PBKDF2-SHA-256, 120000 iterations, AES-GCM-256, 16-byte salt, 12-byte iv.
 * The key never leaves the machine that created it.
 */

export const SEAL_ITERATIONS = 120_000;

export interface SealPayload {
  name: string;
  summary: string;
  tags: string[];
  content: string;
}

export interface SealEnvelope {
  v: 1;
  salt: string;
  iv: string;
  data: string;
}

export function newShareKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `cs1_${bytesToBase64Url(bytes)}`;
}

export function newShareId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `share-${bytesToBase64Url(bytes)}`;
}

export async function sealSnippet(
  payload: SealPayload,
  key: string
): Promise<SealEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await deriveKey(key, salt, ["encrypt"]);
  const plain = new TextEncoder().encode(JSON.stringify(normalizePayload(payload)));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, plain)
  );
  return {
    v: 1,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(cipher),
  };
}

export async function openSnippet(
  envelope: SealEnvelope,
  key: string
): Promise<SealPayload | null> {
  try {
    if (envelope.v !== 1 || !key) return null;
    const salt = base64ToBytes(envelope.salt);
    const iv = base64ToBytes(envelope.iv);
    const data = base64ToBytes(envelope.data);
    if (salt.length !== 16 || iv.length !== 12 || data.length === 0) return null;
    const aes = await deriveKey(key, salt, ["decrypt"]);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      aes,
      data as BufferSource
    );
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as Partial<SealPayload>;
    if (typeof parsed.name !== "string" || typeof parsed.content !== "string") {
      return null;
    }
    return {
      name: parsed.name,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
      content: parsed.content,
    };
  } catch {
    return null;
  }
}

function normalizePayload(payload: SealPayload): SealPayload {
  return {
    name: payload.name,
    summary: payload.summary || "",
    tags: payload.tags || [],
    content: payload.content,
  };
}

async function deriveKey(
  key: string,
  salt: Uint8Array,
  usages: KeyUsage[]
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: SEAL_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
