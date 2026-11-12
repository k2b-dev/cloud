import { hkdfSync } from "node:crypto";
import { getProcessApplicationId } from "../_internal/process-identity";
import { validatePurposeName } from "../_internal/purpose-name";
import { appSecretRoots } from "../runtime/app-secret";
import { connections } from "../runtime/connections";

/** Derive current-first purpose keys for overlapping-root verification. */
export const appKeys = (name: string): string[] => {
  validatePurposeName(name);
  const appId = getProcessApplicationId();
  if (!appId) throw new Error("Start the application before using appKey()");
  const secret = connections().appSecret.current;
  if (!secret.trim()) throw new Error("APP_SECRET is required to derive application signing keys");
  return appSecretRoots(connections().appSecret).map((root) =>
    Buffer.from(hkdfSync("sha256", root, appId, name, 32)).toString("base64url"),
  );
};

/** Sign with current; verify with each key returned by appKeys(name). */
export const appKey = (name: string): string => appKeys(name)[0]!;
