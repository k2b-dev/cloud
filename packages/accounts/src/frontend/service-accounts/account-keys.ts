import { type AccountKey, type KeyContext, toAccountKey } from "./api-key-row";

/** Keys one page of an account's key section shows; the same page size on the server and through the APIs. */
export const KEYS_PER_PAGE = 50;

/**
 * Whose keys a section shows, and so which existing API pages them: an agent's or an API key account's (a
 * resource-bound account, such as an app's rotating keys: all their keys, through
 * `GET /api/admin/identity/service-accounts/:id/api-keys`), or a person's own keys (the active ones, through
 * `GET /api/accounts/service-accounts?userId=…&kind=user_delegated&status=active`).
 */
export type KeyOwner = { kind: "agent"; id: string } | { kind: "resource"; id: string } | { kind: "person"; userId: string };

/**
 * One page of an account's keys as the section shows it; `total` counts all of them, on every page. `open` is the
 * key the address names (`?key=`) as the server looked it up by its id, wherever it stands: the key when it belongs to
 * this account, null when it does not; absent when the address names no key.
 */
export type KeyPage = { keys: AccountKey[]; total: number; page: number; open?: AccountKey | null };

/** The filter the service reads a page of an owner's keys with, so the server's first page and the APIs agree. */
export const keyFilter = (owner: KeyOwner) =>
  owner.kind === "agent" || owner.kind === "resource"
    ? { serviceAccountId: owner.id }
    : { userId: owner.userId, serviceAccountKind: "user_delegated" as const, credentialStatus: "active" as const };

/** A page of keys from the service's overview items, formatted for the person. */
export const toKeyPage = (
  answer: { items: Parameters<typeof toAccountKey>[0][]; total: number },
  page: number,
  context: KeyContext,
): KeyPage => ({ keys: answer.items.map((entry) => toAccountKey(entry, context)), total: answer.total, page });
