import { type MailDraftSeed, mailDraftSeedSchema } from "../../contracts";

const SEED_TTL_MS = 24 * 60 * 60 * 1_000;
const SEED_PREFIX = "cloud:mail:draft-seed:";

export const mailDraftSeedKey = (mailboxId: string, seedId: string): string => `cloud:mail:draft-seed:${mailboxId}:${seedId}`;

export const storeMailDraftSeed = (storage: Storage, seed: MailDraftSeed): void => {
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (!key?.startsWith(SEED_PREFIX)) continue;
    const raw = storage.getItem(key);
    try {
      const parsed = raw ? mailDraftSeedSchema.safeParse(JSON.parse(raw)) : null;
      if (!parsed?.success || Date.now() - new Date(parsed.data.createdAt).getTime() > SEED_TTL_MS) {
        storage.removeItem(key);
      }
    } catch {
      storage.removeItem(key);
    }
  }
  storage.setItem(mailDraftSeedKey(seed.mailboxId, seed.id), JSON.stringify(seed));
};

export const readMailDraftSeed = (storage: Storage, mailboxId: string, seedId: string): MailDraftSeed | null => {
  const key = mailDraftSeedKey(mailboxId, seedId);
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = mailDraftSeedSchema.safeParse(JSON.parse(raw));
    if (
      !parsed.success ||
      parsed.data.mailboxId !== mailboxId ||
      parsed.data.id !== seedId ||
      Date.now() - new Date(parsed.data.createdAt).getTime() > SEED_TTL_MS
    ) {
      storage.removeItem(key);
      return null;
    }
    return parsed.data;
  } catch {
    storage.removeItem(key);
    return null;
  }
};

export const removeMailDraftSeed = (storage: Storage, mailboxId: string, seedId: string): void => {
  storage.removeItem(mailDraftSeedKey(mailboxId, seedId));
};
