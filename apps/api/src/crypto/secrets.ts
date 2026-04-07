import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// AES-256-GCM with key derived from SECRETS_MASTER_KEY (sha256) for simplicity.
// In production, consider a KMS/KeyVault integration; the API stays the same.

function deriveKey(masterKey: string) {
  return createHash("sha256").update(masterKey, "utf8").digest(); // 32 bytes
}

export function encryptString(plaintext: string, masterKey: string) {
  const key = deriveKey(masterKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.from(
    JSON.stringify({
      v: 1,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ct: ciphertext.toString("base64")
    }),
    "utf8"
  ).toString("base64");
}

export function decryptString(ciphertextB64: string, masterKey: string) {
  const key = deriveKey(masterKey);
  const json = Buffer.from(ciphertextB64, "base64").toString("utf8");
  const parsed = JSON.parse(json) as { v: number; iv: string; tag: string; ct: string };
  if (parsed.v !== 1) throw new Error("Unsupported secret version");
  const iv = Buffer.from(parsed.iv, "base64");
  const tag = Buffer.from(parsed.tag, "base64");
  const ct = Buffer.from(parsed.ct, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString("utf8");
}

