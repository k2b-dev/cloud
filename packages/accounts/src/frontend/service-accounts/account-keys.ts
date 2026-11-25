import { type AccountKey, type KeyContext, toAccountKey } from "./api-key-row";

/** Keys one page of an account's key section shows; the same page size on the server and through the APIs. */
export const KEYS_PER_PAGE = 50;

/**
 * Whose keys a section shows, and so which existing API pages them: an agent's (all its keys, through
 * `GET /api/admin/identity/service-accounts/:id/api-keys`) or a person's own keys (the active ones, through
 * `GET /api/accounts/service-accounts?userId=…&kind=user_delegated&status=active`).
 */
export type KeyOwner = { kind: "agent"; id: string } | { kind: "person"; userId: string };

/** One page of an account's keys as the section shows it; `total` counts all of them, on every page. */
export type KeyPage = { keys: AccountKey[]; total: number; page: number };

/** The filter the service reads a page of an owner's keys with, so the server's first page and the APIs agree. */
export const keyFilter = (owner: KeyOwner) =>
  owner.kind === "agent"
    ? { serviceAccountId: owner.id }
    : { userId: owner.userId, serviceAccountKind: "user_delegated" as const, credentialStatus: "active" as const };

/** A page of keys from the service's overview items, formatted for the person. */
export const toKeyPage = (
  answer: { items: Parameters<typeof toAccountKey>[0][]; total: number },
  page: number,
  context: KeyContext,
): KeyPage => ({ keys: answer.items.map((entry) => toAccountKey(entry, context)), total: answer.total, page });
