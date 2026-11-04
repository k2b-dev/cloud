import type { AccessEntry } from "@k2b/cloud/contracts";
import { openStudioAccess } from "./StudioPermissions";

// Fictional fixtures only. The Code account's title is what Core returns to someone who manages the app.
const entries: AccessEntry[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    principal: { type: "user", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    permission: "admin",
    displayName: "Alex Example",
    createdAt: "2026-10-23T12:00:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    principal: { type: "service_account", serviceAccountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    permission: "read",
    displayName: "Invoice agent",
    serviceAccountKind: "agent",
    createdAt: "2026-10-23T12:00:00.000Z",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    principal: { type: "service_account", serviceAccountId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    permission: "read",
    displayName: "Reporting service",
    serviceAccountKind: "standalone",
    createdAt: "2026-10-23T12:00:00.000Z",
  },
  {
    id: "66666666-6666-4666-8666-666666666666",
    principal: { type: "service_account", serviceAccountId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
    permission: "read",
    displayName: "Code von einkauf-und-rechnungseingang@beispiel.de",
    serviceAccountKind: "code",
    serviceAccountDescription: "Dienstkonto eines Postfachs",
    createdAt: "2026-10-23T12:00:00.000Z",
  },
];
const calls: string[] = [];
Object.assign(window, { studioAccessCalls: calls });

const open = () =>
  openStudioAccess({
    artifactId: "App234",
    title: "Angebotsrechner",
    published: true,
    viewerUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    locale: document.documentElement.lang || "en",
    entries,
    projects: [],
    grant: async (principal, permission) => {
      calls.push(`grant ${principal.type} ${permission}`);
      return { id: crypto.randomUUID(), principal, permission, createdAt: "2026-10-23T12:00:00.000Z" };
    },
    change: async (id, permission) => {
      calls.push(`change ${id} ${permission}`);
    },
  });

const reopen = document.createElement("button");
reopen.textContent = "Open sharing";
reopen.addEventListener("click", () => void open());
document.getElementById("root")!.append(reopen);
void open();
