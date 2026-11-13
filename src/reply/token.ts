import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class ReplyTokenCipher {
  private readonly key: Buffer;
  constructor(key: string) {
    if (!/^[0-9a-f]{64}$/.test(key))
      throw new Error("invalid_reply_encryption_key");
    this.key = Buffer.from(key, "hex");
  }
  seal(token: string, deliveryId: string): string {
    return this.encrypt(token, deliveryId, 512);
  }
  sealPayload(value: string, context: string): string {
    return this.encrypt(value, context, 65536);
  }
  private encrypt(token: string, deliveryId: string, limit: number): string {
    if (!token || Buffer.byteLength(token) > limit || !deliveryId)
      throw new Error("invalid_reply_token");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`reply:v1:${deliveryId}`));
    const bytes = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString(
      "base64url",
    );
  }
  open(sealed: string, deliveryId: string): string {
    return this.decrypt(sealed, deliveryId, 512);
  }
  openPayload(value: string, context: string): string {
    return this.decrypt(value, context, 65536);
  }
  private decrypt(sealed: string, deliveryId: string, limit: number): string {
    try {
      if (
        !/^[A-Za-z0-9_-]+$/.test(sealed) ||
        sealed.length > Math.ceil(((limit + 28) * 4) / 3)
      )
        throw new Error();
      const bytes = Buffer.from(sealed, "base64url");
      if (bytes.length <= 28 || bytes.length > limit + 28 || !deliveryId)
        throw new Error();
      const cipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        bytes.subarray(0, 12),
      );
      cipher.setAAD(Buffer.from(`reply:v1:${deliveryId}`));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        cipher.update(bytes.subarray(28)),
        cipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("reply_token_unavailable");
    }
  }
}
