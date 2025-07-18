import crypto from "crypto";

export function md5(str: string): string {
  return crypto.createHash("md5").update(str).digest("hex");
}

export function sha256(str: string): string {
  return crypto.createHash("sha256").update(str).digest("base64");
}

function saltedKey(key: string, size = 32): string {
  const { DUST_DEVELOPERS_SECRETS_SECRET } = process.env;
  return crypto
    .createHash("sha256")
    .update(DUST_DEVELOPERS_SECRETS_SECRET + key)
    .digest("base64")
    .substring(0, size);
}

export function encrypt(text: string, key: string): string {
  const iv = md5(key).substring(0, 16);
  const cipher = crypto.createCipheriv("aes-256-cbc", saltedKey(key), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return encrypted;
}

export function decrypt(encrypted: string, key: string): string {
  const iv = md5(key).substring(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", saltedKey(key), iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}
