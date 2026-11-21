import { z } from "zod";
import { invokeCapabilityWithDataSchema } from "../capabilities/client";
import { SecretSetSchema } from "../code/secret-metadata";
import type { CodeSecretBinding } from "../contracts/code-secrets";

export { SecretListSchema, SecretSchema, SecretSetSchema } from "../code/secret-metadata";

/** Core's printable ASCII header-value contract. Chat secrets retain their wider legacy contract. */
export const valueAllowed = (value: string) => /^[\x20-\x7e]+$/.test(value);

/** No idempotency key: neither a value nor its digest belongs in capability history. */
export const writeSecret = (
  codeId: string,
  input: { name: string; value: string; binding_revision: string | null; binding?: CodeSecretBinding },
  signal?: AbortSignal,
) =>
  invokeCapabilityWithDataSchema(
    { appId: "core", capabilityId: "code.secret.set", kind: "action", target: { type: "core.code", id: codeId }, input, signal },
    SecretSetSchema,
  );

/** Check before sending any value. A failed check is distinct from a refused destination. */
export const secretCheck = async (codeId: string, binding: unknown, signal?: AbortSignal): Promise<boolean | null> => {
  try {
    const response = await fetch("/api/code/authoring/secretCheck", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ codeId, binding }),
      signal,
    });
    if (!response.ok) return null;
    const parsed = z.object({ allowed: z.boolean() }).safeParse(await response.json());
    return parsed.success ? parsed.data.allowed : null;
  } catch {
    return null;
  }
};
