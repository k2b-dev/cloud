import { isAgentServiceAccountKind, isLegacyLimitedApiKey, isModelsOnlyApiKey } from "@k2b/cloud/contracts";
import type { ServiceAccountCredentialOverview } from "@k2b/cloud/services";
import { dates } from "@k2b/stdlib";
import type { ApiKeyKind } from "./query";

/** One API key of an account as Accounts shows it. The server formats every date, so the first paint and the live page agree. */
export type AccountKey = {
  id: string;
  name: string;
  /** The readable start of the token, such as `cld_7f3a_…`; the token itself is never shown again. */
  prefix: string;
  active: boolean;
  /** A key with a narrower purpose than its account: only AI models, or an agent's key from before keys acted as it. */
  access: "models" | "legacy" | null;
  created: string;
  lastUsed: string | null;
  expires: string | null;
  /** Past its end at the time of the answer: it works no more, although its status still says active. */
  expired: boolean;
  /** An agent's active legacy key: a new key that acts as the agent can replace it. */
  replace?: { serviceAccountId: string };
};

/** Who a key belongs to, as the list of all keys shows it: a person and an agent lead to their page. */
export type ApiKeyOwner =
  | { kind: "user"; name: string; detail: string; href: string; image?: string }
  | { kind: "agent"; name: string; href: string }
  | { kind: "resource"; name: string; detail: string };

/** One API key in the list of all keys: the key, the kind of its account and its owner. */
export type ApiKeyRow = AccountKey & { kind: ApiKeyKind; owner: ApiKeyOwner };

/** The person's language and time zone, and the time of the answer (for `expired`). */
export type KeyContext = { locale: string; timeZone: string; now: Date };

/** What a key needs from the service's overview, as the server reads it and the APIs answer it. */
export type KeySource = {
  id: string;
  name: string;
  status: "active" | "revoked";
  tokenPrefix: string;
  scopes: readonly string[];
  expiresAt: string | Date | null;
  lastUsedAt: string | Date | null;
  createdAt: string | Date;
  serviceAccount: { id: string; kind: string };
};

/** The key as an account's record shows it, with dates in the person's language and time zone. */
export const toAccountKey = (entry: KeySource, context: KeyContext): AccountKey => {
  const format = { locale: context.locale, timeZone: context.timeZone };
  const when = (value: string | Date | null) => (value ? dates.formatDateTime(value, format) : null);
  const agent = isAgentServiceAccountKind(entry.serviceAccount.kind);
  const legacy = agent && isLegacyLimitedApiKey(entry);
  return {
    id: entry.id,
    name: entry.name,
    prefix: `cld_${entry.tokenPrefix}_…`,
    active: entry.status === "active",
    access: isModelsOnlyApiKey(entry) ? "models" : legacy ? "legacy" : null,
    created: dates.formatDateTime(entry.createdAt, format),
    lastUsed: when(entry.lastUsedAt),
    expires: when(entry.expiresAt),
    expired: entry.expiresAt !== null && new Date(entry.expiresAt).getTime() <= context.now.getTime(),
    ...(legacy && entry.status === "active" ? { replace: { serviceAccountId: entry.serviceAccount.id } } : {}),
  };
};

/** The key as the list of all keys shows it, with its account's kind and owner. */
export const toApiKeyRow = (entry: ServiceAccountCredentialOverview, context: KeyContext): ApiKeyRow => {
  const owner = entry.owner;
  return {
    ...toAccountKey(entry, context),
    kind: isAgentServiceAccountKind(entry.serviceAccount.kind)
      ? "agent"
      : entry.serviceAccount.kind === "user_delegated"
        ? "user_delegated"
        : "resource_bound",
    owner:
      owner.type === "user"
        ? {
            kind: "user",
            name: owner.displayName || owner.uid,
            detail: owner.mail ?? owner.uid,
            href: `/app/accounts/users/${owner.userId}`,
            image: owner.avatarHash
              ? `/api/accounts/users/${encodeURIComponent(owner.userId)}/avatar?rev=${encodeURIComponent(owner.avatarHash)}`
              : undefined,
          }
        : owner.type === "standalone"
          ? { kind: "agent", name: owner.name, href: `/app/accounts/agents/${owner.serviceAccountId}` }
          : { kind: "resource", name: owner.appId, detail: `${owner.resourceType || "resource"} · ${owner.resourceId || "–"}` },
  };
};
