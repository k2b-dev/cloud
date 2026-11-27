import { LocaleProvider } from "@k2b/ui";
import { Bar, Pane, Section, Text, Workspace } from "@k2b/ui/v2";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { AccessEntry } from "../contracts/shared";
import { PermissionEditor, type PickedPrincipal, PrincipalPicker } from "./v2";

/**
 * The v2 permission editor in a v2 settings pane, with invented people, a group and an agent. Changes are recorded
 * on `window.calls`; `?fail` lets the first level change fail, `?readonly` shows it without the right to change,
 * `?worst` lists the worst case (long, unbreakable and non-Latin names, many rows). Below it, a picker of several
 * principals (`PrincipalPicker` of v2), as a new chat asks for its people: what it holds is on `window.picked`.
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
        ...(url.searchParams.get("kinds")?.includes("service_account")
          ? [
              {
                kind: "service_account",
                serviceAccount: {
                  id: "20000000-0000-4000-8000-000000000023",
                  name: "Inventurbot",
                  kind: "agent",
                  appId: null,
                  resourceType: null,
                  resourceId: null,
                  status: "active",
                },
              },
            ]
          : []),
      ],
      pagination: { page: 1, per_page: 20, total: 2, total_pages: 1, has_next: false },
    });
  },
  { preconnect: originalFetch.preconnect },
);

const page = window as unknown as { calls: unknown[]; picked: string[] };
page.calls = [];
page.picked = [];
const [picked, setPicked] = createSignal<PickedPrincipal[]>([]);
let failures = params.has("fail") ? 1 : 0;
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
              grantAccess={async (principal, permission) => {
                page.calls.push({ grant: principal, permission });
                return { id: id(99), principal, permission, createdAt: "2026-11-26T00:00:00.000Z" };
              }}
              updateAccess={async (accessId, permission) => {
                if (failures > 0) {
                  failures -= 1;
                  throw new Error("The change could not be saved.");
                }
                page.calls.push({ update: accessId, permission });
              }}
              revokeAccess={async (accessId) => void page.calls.push({ revoke: accessId })}
            />
          </Section>
          <Section icon="messages" title="New chat">
            <PrincipalPicker
              label="People"
              value={picked()}
              onChange={(next) => {
                setPicked(next);
                page.picked = next.map((entry) => entry.display.displayName);
              }}
              allowAuthenticated={false}
            />
          </Section>
        </Pane>
      </Workspace>
    </LocaleProvider>
  ),
  host,
);
