import { crypto } from "@k2b/stdlib";

const KEY_PATTERN = /^[0-9a-f]{64}$/i;

export type IdentityKeyEncryptionConfig = {
  current: { id: string; key: string };
  previous: { id: string; key: string } | null;
  next: { id: string; key: string } | null;
};

const parseKey = (name: string, value: string | undefined, required: boolean): string | null => {
  const normalized = value?.trim() ?? "";
  if (!normalized && !required) return null;
  if (!KEY_PATTERN.test(normalized)) {
    throw new Error(`${name} must be exactly 32 high-entropy bytes encoded as 64 hexadecimal characters`);
  }
  return normalized.toLowerCase();
};

const identify = async (key: string): Promise<{ id: string; key: string }> => ({
  id: (await crypto.common.hash(key)).slice(0, 16),
  key,
});

export const readIdentityKeyEncryptionConfig = async (): Promise<IdentityKeyEncryptionConfig> => {
  if ((process.env.APP_ID ?? "").trim() !== "core") {
    throw new Error("Private Cloud identity keys may only be loaded by the Core application");
  }
  const current = parseKey("CLOUD_IDENTITY_KEY_ENCRYPTION_KEY", process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY, true)!;
  const previous = parseKey("CLOUD_IDENTITY_PREVIOUS_KEY", process.env.CLOUD_IDENTITY_PREVIOUS_KEY, false);
  const next = parseKey("CLOUD_IDENTITY_NEXT_KEY", process.env.CLOUD_IDENTITY_NEXT_KEY, false);
  const currentIdentified = await identify(current);
  const previousIdentified = previous ? await identify(previous) : null;
  const nextIdentified = next ? await identify(next) : null;
  const ids = [currentIdentified.id, previousIdentified?.id, nextIdentified?.id].filter((id): id is string => Boolean(id));
  if (new Set(ids).size !== ids.length) {
    throw new Error("Configured Cloud identity KEKs must be distinct");
  }
  if (previousIdentified && nextIdentified) throw new Error("Configure either CLOUD_IDENTITY_PREVIOUS_KEY or CLOUD_IDENTITY_NEXT_KEY, not both");
  return { current: currentIdentified, previous: previousIdentified, next: nextIdentified };
};
