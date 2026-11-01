import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { connections } from "../runtime/connections";

type Roots = { current: string; previous?: string };
const key = (root: string, purpose: string) => {
  const raw = root.trim();
  if (!raw || !purpose) throw new Error("secret_cipher_unavailable");
  const material = raw.length % 2 === 0 && /^[a-f0-9]+$/i.test(raw) ? Buffer.from(raw, "hex") : createHash("sha256").update(raw).digest();
  return Buffer.from(hkdfSync("sha256", material, "cloud.purpose-secret.v1", purpose, 32));
};
/** AES-256-GCM with a purpose key derived from APP_SECRET via HKDF. Context authenticates the owning row.
 * Reads try current and previous roots. Writes always use current; operators re-encrypt before retiring previous.
 * Explicit roots are for offline root migration; never accept them from request input.
 */
export function purposeSecretCipher(purpose: string, roots: Roots = connections().appSecret) {
  return {
    encrypt(value: string, context: string): string {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key(roots.current, purpose), nonce);
      cipher.setAAD(Buffer.from(context));
      const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return ["v1", nonce.toString("hex"), cipher.getAuthTag().toString("hex"), bytes.toString("hex")].join(":");
    },
    decrypt(value: string, context: string): string {
      const parts = value.split(":");
      if (
        parts.length === 4 &&
        parts[0] === "v1" &&
        /^[a-f0-9]{24}$/.test(parts[1]!) &&
        /^[a-f0-9]{32}$/.test(parts[2]!) &&
        /^(?:[a-f0-9]{2})*$/.test(parts[3]!)
      ) {
        for (const root of [roots.current, roots.previous]) {
          if (!root) continue;
          try {
            const cipher = createDecipheriv("aes-256-gcm", key(root, purpose), Buffer.from(parts[1]!, "hex"));
            cipher.setAAD(Buffer.from(context));
            cipher.setAuthTag(Buffer.from(parts[2]!, "hex"));
            return Buffer.concat([cipher.update(Buffer.from(parts[3]!, "hex")), cipher.final()]).toString("utf8");
          } catch {
            /* Try the previous root, without exposing ciphertext or crypto exception text. */
          }
        }
      }
      throw new Error("secret_unreadable");
    },
  };
}
