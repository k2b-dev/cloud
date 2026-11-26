import type { AccessEntry, Principal } from "../contracts/shared";
import { openAccessDialog, ResourceApiKeys } from "./v2";

/**
 * The v2 access dialog for a browser test: invented people, groups and agents; the directory answers searches and
 * e-mails; grants, changes and removals are recorded on `window.calls`. `?worst` lists the worst case (long,
 * unbreakable and non-Latin names, many rows), `?readonly` opens it without the right to change access, `?public`
 * offers public access with a link, `?keys` adds the resource's API keys below.
 */
const params = new URLSearchParams(location.search);
const person = (id: number, displayName: string, permission: AccessEntry["permission"]): AccessEntry => ({
  id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
  principal: { type: "user", userId: `10000000-0000-4000-8000-${String(id).padStart(12, "0")}` },
  displayName,
  permission,
  createdAt: "2026-11-03T00:00:00.000Z",
});
const entries: AccessEntry[] = params.has("worst")
  ? [
      person(1, "Mia Hoffmann", "admin"),
      ...Array.from({ length: 40 }, (_, index) =>
        person(
          index + 10,
          index % 3 === 0
            ? `Maximiliane Donaudampfschifffahrtsgesellschaftskapitänin ${index}`
            : index % 3 === 1
              ? `${"x".repeat(60)}${index}`
              : `山田 花子 ${index}`,
          (["read", "write", "admin"] as const)[index % 3] ?? "read",
        ),
      ),
    ]
  : [
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

const directory = [
  {
    kind: "user",
    user: { id: "10000000-0000-4000-8000-000000000006", displayName: "Noah Becker", uid: "nbecker", mail: "noah.becker@beispiel.de" },
  },
  {
    kind: "user",
    user: { id: "10000000-0000-4000-8000-000000000002", displayName: "Jonas Weber", uid: "jweber", mail: "jonas.weber@beispiel.de" },
  },
  { kind: "group", group: { id: "30000000-0000-4000-8000-000000000007", name: "Einkauf", description: "12 Mitglieder" } },
];
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), location.href);
    if (url.pathname !== "/api/accounts/entities") return originalFetch(input, init);
    const search = url.searchParams.get("search")?.toLowerCase();
    if (search !== undefined)
      return Response.json({
        items: directory.filter((item) =>
          (item.kind === "user" ? item.user!.displayName : item.group!.name).toLowerCase().includes(search),
        ),
      });
    const ids = url.searchParams.get("user_ids")?.split(",") ?? [];
    const items = ids.map((id) => ({ kind: "user", user: { id, mail: `${id.slice(-4)}@beispiel.de` } }));
    return Response.json({ items, pagination: { page: 1, per_page: 1, total: 214, total_pages: 214, has_next: true } });
  },
  { preconnect: originalFetch.preconnect },
);

const page = window as unknown as {
  calls: unknown[];
  result?: boolean;
  openShare: () => void;
};
page.calls = [];
let next = 100;
page.openShare = () => {
  page.result = undefined;
  void openAccessDialog({
    resourceName: "Lager Nord",
    subtitle: "Space · Spaces",
    initialEntries: entries,
    canEdit: !params.has("readonly"),
    allowPublic: params.has("public"),
    publicLink: params.has("public") ? "https://cloud.beispiel.de/s/lager-nord" : undefined,
    grantAccess: async (principal: Principal, permission) => {
      page.calls.push({ grant: principal, permission });
      next += 1;
      return { id: `00000000-0000-4000-8000-000000000${next}`, principal, permission, createdAt: "2026-11-26T00:00:00.000Z" };
    },
    updateAccess: async (accessId, permission) => void page.calls.push({ update: accessId, permission }),
    revokeAccess: async (accessId) => void page.calls.push({ revoke: accessId }),
    extraSections: params.has("keys") ? (
      <ResourceApiKeys
        initialKeys={[
          {
            id: "50000000-0000-4000-8000-000000000001",
            name: "Lagerimport",
            tokenPrefix: "k2b_7Hq",
            permission: "write",
            createdAt: "2026-11-01T08:00:00.000Z",
            expiresAt: "2027-02-01T08:00:00.000Z",
            lastUsedAt: null,
          } as never,
        ]}
        createKey={async (input) => {
          page.calls.push({ createKey: input.name, permission: input.permission, expires: input.expiresAt !== null });
          return {
            credential: {
              id: "50000000-0000-4000-8000-000000000002",
              name: input.name,
              tokenPrefix: "k2b_Zx9",
              permission: input.permission,
              createdAt: "2026-11-26T08:00:00.000Z",
              expiresAt: input.expiresAt,
              lastUsedAt: null,
            } as never,
            token: "k2b_Zx9-invented-token-for-the-test",
          };
        }}
        revokeKey={async (id) => void page.calls.push({ revokeKey: id })}
      />
    ) : undefined,
  }).then((saved) => {
    page.result = saved;
  });
};
page.openShare();
