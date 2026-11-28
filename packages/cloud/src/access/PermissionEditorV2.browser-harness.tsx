import { LocaleProvider } from "@k2b/ui";
import { Bar, Pane, Section, Text, Workspace } from "@k2b/ui/v2";
import { render } from "solid-js/web";
import type { AccessEntry } from "../contracts/shared";
import { PermissionEditor } from "./v2";

/**
 * The v2 permission editor in a v2 settings pane, with invented people, a group and an agent. Changes are recorded
 * on `window.calls`; `?fail` lets the first level change fail, `?failrevoke` the first removal, `?guard` the first
 * check before a change (`beforeChange` throws before the row saves), `?readonly` shows it without the right to change,
 * `?worst` lists the worst case (long, unbreakable and non-Latin names, many rows).
 */
const params = new URLSearchParams(location.search);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const person = (n: number, displayName: string, permission: AccessEntry["permission"]): AccessEntry => ({
  id: id(n),
  principal: { type: "user", userId: `10000000-0000-4000-8000-${String(n).padStart(12, "0")}` },
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
        id: id(3),
        principal: { type: "group", groupId: "30000000-0000-4000-8000-000000000003" },
        displayName: "Logistik",
        permission: "read",
        createdAt: "2026-11-03T00:00:00.000Z",
      },
      {
        id: id(4),
        principal: { type: "service_account", serviceAccountId: "20000000-0000-4000-8000-000000000004" },
        displayName: "Lagerbot",
        permission: "write",
        serviceAccountKind: "agent",
        createdAt: "2026-11-03T00:00:00.000Z",
      },
      { id: id(5), principal: { type: "authenticated" }, permission: "read", createdAt: "2026-11-03T00:00:00.000Z" },
    ];

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), location.href);
    if (url.pathname !== "/api/accounts/entities") return originalFetch(input, init);
    if (url.searchParams.get("kinds") === "group")
      return Response.json({
        items: [{ kind: "group", group: { id: "g", name: "Logistik", provider: "local" } }],
        pagination: { total: 1, has_next: false },
      });
    return Response.json({
      items: [
        {
          kind: "user",
          user: { id: "10000000-0000-4000-8000-000000000021", displayName: "Noah Becker", uid: "nbecker", mail: "noah@beispiel.de" },
        },
        {
          kind: "user",
          user: { id: "10000000-0000-4000-8000-000000000022", displayName: "Lea Schmitt", uid: "lschmitt", mail: "lea@beispiel.de" },
        },
      ],
      pagination: { page: 1, per_page: 20, total: 2, total_pages: 1, has_next: false },
    });
  },
  { preconnect: originalFetch.preconnect },
);

const page = window as unknown as { calls: unknown[] };
page.calls = [];
let failures = params.has("fail") ? 1 : 0;
let revokeFailures = params.has("failrevoke") ? 1 : 0;
let guardFailures = params.has("guard") ? 1 : 0;
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
render(
  () => (
    <LocaleProvider locale="en">
      <Workspace head={<Bar start={<Text>Lager Nord</Text>} />}>
        <Pane label="Settings">
          <Section icon="lock" title="Who has access">
            <PermissionEditor
              initialEntries={entries}
              canEdit={!params.has("readonly")}
              grantAccess={async (principal, permission) => ({ id: id(99), principal, permission, createdAt: "2026-11-26T00:00:00.000Z" })}
              updateAccess={async (accessId, permission) => {
                if (failures > 0) {
                  failures -= 1;
                  throw new Error("The change could not be saved.");
                }
                page.calls.push({ update: accessId, permission });
              }}
              revokeAccess={async (accessId) => {
                if (revokeFailures > 0) {
                  revokeFailures -= 1;
                  throw new Error("The access could not be removed.");
                }
                page.calls.push({ revoke: accessId });
              }}
              beforeChange={
                params.has("guard")
                  ? async () => {
                      if (guardFailures > 0) {
                        guardFailures -= 1;
                        throw new Error("The policy could not be checked.");
                      }
                      return true;
                    }
                  : undefined
              }
            />
          </Section>
        </Pane>
      </Workspace>
    </LocaleProvider>
  ),
  host,
);
