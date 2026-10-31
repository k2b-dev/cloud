import { redis } from "../../runtime/clients";

const KEY_PREFIX = "auth:proxy-return:";
const DEFAULT_TTL_SECONDS = 300;

type ProxyReturnPayload = {
  clientId: string;
  url: string;
};

const key = (token: string) => `${KEY_PREFIX}${token}`;

const normalizeReturnUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
};

export const create = async (params: { clientId: string; url: string; ttlSeconds?: number }): Promise<string | null> => {
  const url = normalizeReturnUrl(params.url);
  if (!url) return null;

  const token = crypto.randomUUID();
  const payload: ProxyReturnPayload = {
    clientId: params.clientId,
    url,
  };
  await redis.set(key(token), JSON.stringify(payload), "EX", params.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  return token;
};

export const consume = async (params: { token: string }): Promise<ProxyReturnPayload | null> => {
  const raw = await redis.getdel(key(params.token));
  if (!raw) return null;

  try {
    const payload = JSON.parse(raw) as Partial<ProxyReturnPayload>;
    if (typeof payload.clientId !== "string" || typeof payload.url !== "string") return null;
    const url = normalizeReturnUrl(payload.url);
    if (!url) return null;
    return { clientId: payload.clientId, url };
  } catch {
    return null;
  }
};
