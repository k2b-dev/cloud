import type { AccessEntry, ServiceAccountKind } from "../contracts/shared";
import { openAccessDialog } from "./AccessDialog";

const person = (id: number, displayName: string, permission: AccessEntry["permission"]): AccessEntry => ({
  id: `00000000-0000-4000-8000-00000000000${id}`,
  principal: { type: "user", userId: `10000000-0000-4000-8000-00000000000${id}` },
  displayName,
  permission,
  createdAt: "2026-11-03T00:00:00.000Z",
});
const entries: AccessEntry[] = [
  person(1, "Mia Hoffmann", "admin"),
  person(2, "Jonas Weber", "write"),
  {
    id: "00000000-0000-4000-8000-000000000003",
    principal: { type: "group", groupId: "30000000-0000-4000-8000-000000000003" },
    displayName: "Logistik",
    permission: "read",
    createdAt: "2026-11-03T00:00:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    principal: { type: "service_account", serviceAccountId: "20000000-0000-4000-8000-000000000004" },
    displayName: "Lagerbot",
    permission: "write",
    serviceAccountKind: "agent",
    createdAt: "2026-11-03T00:00:00.000Z",
  },
  person(5, "Lea Schmitt", "read"),
];

/** What the directory knows about the listed people, as the search endpoint answers for someone who manages. */
const mails: Record<string, string> = {
  "10000000-0000-4000-8000-000000000001": "mia.hoffmann@beispiel.de",
  "10000000-0000-4000-8000-000000000002": "jonas.weber@beispiel.de",
  "10000000-0000-4000-8000-000000000005": "lea.schmitt@beispiel.de",
};
const directoryFetch = window.fetch.bind(window);
window.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://harness.test");
    if (url.pathname !== "/api/accounts/entities") return directoryFetch(input, init);
    const ids = url.searchParams.get("user_ids")?.split(",") ?? [];
    const items = ids.flatMap((id) => (mails[id] ? [{ kind: "user", user: { id, mail: mails[id] } }] : []));
    return Response.json({ items, pagination: { page: 1, per_page: 1, total: 214, total_pages: 214, has_next: true } });
  },
  { preconnect: window.fetch.preconnect },
);

/**
 * State `loading` keeps the list loading until `finishLoading()`; state `saving` keeps each save pending until
 * `finishSaving()`. The test sets `window.accessDialogState` before the harness runs.
 */
const harness = window as unknown as { accessDialogState?: string; finishLoading?: () => void; finishSaving?: () => void };
const pending = () => Promise.withResolvers<void>();
const loadGate = pending();
harness.finishLoading = loadGate.resolve;
let saveGate = pending();
harness.finishSaving = () => {
  saveGate.resolve();
  saveGate = pending();
};
const saving = harness.accessDialogState === "saving";

void openAccessDialog({
  resourceName: "Einkauf 2027",
  subtitle: "Space · Spaces",
  ...(harness.accessDialogState === "loading"
    ? { loadEntries: async () => (await loadGate.promise, entries) }
    : { initialEntries: entries }),
  allowPublic: true,
  publicLink: "https://cloud.example.test/s/einkauf-2027",
  entryDetail: (entry) => (entry.principal.type === "group" ? "Group · 14 people" : undefined),
  findServiceAccount: async (handle) =>
    handle === "code-7k2q9m4xwt"
      ? {
          principal: { type: "service_account", serviceAccountId: "40000000-0000-4000-8000-000000000001" },
          // The kind `code` arrives with the code lane; the contract type does not list it yet.
          display: { displayName: "Code of info@example.test", serviceAccountKind: "code" as unknown as ServiceAccountKind },
        }
      : null,
  grantAccess: async (principal, permission) => {
    if (saving) await saveGate.promise;
    return { id: crypto.randomUUID(), principal, permission, createdAt: "now" };
  },
  updateAccess: async () => {
    if (saving) await saveGate.promise;
  },
  revokeAccess: async () => {
    if (saving) await saveGate.promise;
  },
});
document.documentElement.dataset.ready = "true";
