import { hkdfSync } from "node:crypto";
import { getProcessApplicationId } from "../_internal/process-identity";
import { validatePurposeName } from "../_internal/purpose-name";
import { connections } from "../runtime/connections";

/** Derive a purpose-specific signing key from this installation's current secret. */
export const appKey = (name: string): string => {
  validatePurposeName(name);
  const appId = getProcessApplicationId();
  if (!appId) throw new Error("Start the application before using appKey()");
  const secret = connections().appSecret.current;
  if (!secret.trim()) throw new Error("APP_SECRET is required to derive application signing keys");
  return Buffer.from(hkdfSync("sha256", secret, appId, name, 32)).toString("base64url");
};
