import { redis } from "bun";
import type { OAuthScope } from "@/contracts";

export type OAuthConsentRequest = {
  userId: string;
  clientId: string;
  redirectUri: string;
  scopes: OAuthScope[];
  resource: string | null;
  state?: string;
  nonce?: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
};

const CONSENT_TTL_SECONDS = 5 * 60;
const consentKey = (id: string): string => `oauth:consent:${id}`;

const parse = (raw: string | null): OAuthConsentRequest | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OAuthConsentRequest;
  } catch {
    return null;
  }
};

/** Store one validated authorization request behind an unguessable, short-lived form token. */
export const create = async (request: OAuthConsentRequest): Promise<string> => {
  const id = crypto.randomUUID();
  await redis.set(consentKey(id), JSON.stringify(request), "EX", CONSENT_TTL_SECONDS);
  return id;
};

export const get = async (id: string): Promise<OAuthConsentRequest | null> => parse(await redis.get(consentKey(id)));

/** Atomically consume a consent request so approval and denial cannot be replayed. */
export const consume = async (id: string): Promise<OAuthConsentRequest | null> => parse(await redis.getdel(consentKey(id)));
