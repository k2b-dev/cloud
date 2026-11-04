import type { AccessEntry } from "../contracts/shared";
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

void openAccessDialog({
  resourceName: "Einkauf 2027",
  subtitle: "Space · Spaces",
  initialEntries: entries,
  viewerUserId: "10000000-0000-4000-8000-000000000001",
  allowPublic: true,
  publicLink: "https://cloud.example.test/s/einkauf-2027",
  entryDetail: (entry) => (entry.principal.type === "group" ? "Group · 14 people" : undefined),
  findServiceAccount: async (handle) =>
    handle === "code-7k2q9m4xwt"
      ? {
          principal: { type: "service_account", serviceAccountId: "40000000-0000-4000-8000-000000000001" },
          display: { displayName: "Code of info@example.test", serviceAccountKind: "resource_bound" },
        }
      : null,
  grantAccess: async (principal, permission) => ({ id: crypto.randomUUID(), principal, permission, createdAt: "now" }),
  updateAccess: async () => {},
  revokeAccess: async () => {},
});
document.documentElement.dataset.ready = "true";
