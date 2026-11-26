import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { err, fail, ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { keptRecord } from "../../test/fixtures/mail-admin-kept";
import { app as mailApp } from "../config";
import * as kept from "../service/kept-conversations";
import * as publicResources from "../service/public-resources";

// Cloud administration › Mail › Kept renders on v2 from the server: the admin bar with Mail's views one level in, the
// list or the record with their data, and no loading state on the first render. The service decides who may look.
const root = mkdtempSync(join(tmpdir(), "mail-admin-kept-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: listPage } = await import("./admin-kept");
const { default: recordPage } = await import("./admin-kept-detail");

const admin = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "admin",
  roles: ["user", "admin"],
  provider: "local",
  profile: "user",
  givenname: "Ada",
  sn: "Admin",
  displayName: "Ada Admin",
  mail: "admin@example.org",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;

const summary = (index: number): kept.KeptConversationSummary => ({
  mailboxId: `mailbox-${index}`,
  mailboxName: index === 2 ? "Projekt Nordlicht" : "Verwaltung",
  mailboxDeleted: index === 2,
  conversationId: `conversation-${index}`,
  subject: index === 3 ? null : `Kündigung Mietvertrag ${index}`,
  sender: { name: "Paul Weber", address: "paul.weber@example.org" },
  lastMessageAt: "2026-11-25T16:12:00.000Z",
  messageCount: 3,
  keptAt: "2026-11-25T17:02:00.000Z",
  keptBy: { kind: "user", id: "u-1", displayName: "Jana Berger" },
});

const spies: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const app = () => {
  spies.push(
    stubRailSnapshot(),
    // the trend is one bounded count (its own integration test); here it answers with a quiet month
    spyOn(kept, "countKeptPerDay").mockResolvedValue(
      ok(Array.from({ length: 30 }, (_, index) => ({ day: `2026-11-${index}`, count: index % 7 === 0 ? 1 : 0 }))),
    ),
    // "mailbox-1" and "conversation-1" both become "Pub001": each table numbers its own ids
    spyOn(publicResources, "publicIds").mockImplementation(
      async (_table, ids) => new Map(ids.flatMap((id) => (id ? [[id, `Pub${id.slice(-1).padStart(3, "0")}`] as const] : []))),
    ),
  );
  const server = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  server.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user: admin });
    c.set("user", admin);
    // Mail is installed with its admin page, so the admin bar holds its entry and opens its views under it (shown as
    // to a person without app access rules, which the middleware resolves in a running Cloud)
    c.set("runtime", { apps: [{ ...mailApp.meta, access: undefined, adminHref: "/admin/mail" }] });
    await next();
  });
  server.get("/admin/mail/kept", ...listPage);
  server.get("/admin/mail/kept/:mailboxId/:conversationId", ...recordPage);
  return server;
};

const html = async (response: Response) => {
  expect(response.status).toBe(200);
  return response.text();
};

test("the list renders on v2 with its rows, the admin bar and Mail's views, and nothing loading", async () => {
  const server = app();
  const list = spyOn(kept, "listKeptConversations").mockResolvedValue({
    ok: true,
    data: { items: [1, 2, 3].map(summary), nextCursor: "next-1", total: 214 },
  });
  spies.push(list);
  const page = await html(await server.request("/admin/mail/kept?q=Miet&cursor=abc", { headers: { "Accept-Language": "de" } }));
  expect(list).toHaveBeenCalledWith(expect.anything(), { q: "Miet", cursor: "abc", limit: 50 });
  expect(page).toContain('data-k2-part="Table"');
  expect(page).toContain('href="/admin/mail/kept/Pub001/Pub001"');
  expect(page).toContain("Kündigung Mietvertrag 1");
  expect(page).toContain("(Kein Betreff)");
  expect(page).toContain("3 von 214 angezeigt");
  // while searching, a deleted mailbox shows in its row (the exception line belongs to the whole list)
  expect(page).toContain(">gelöscht<");
  expect(page).toContain('href="/admin/mail/kept?q=Miet&amp;cursor=next-1"');
  // Mail's views stand one level in under Mail in the admin bar, the open one current; the v1 tabs are gone
  expect(page).toMatch(/<a [^>]*aria-current="page" data-level="2" href="\/admin\/mail\/kept"/);
  expect(page).toMatch(/<a [^>]*data-k2-part="Nav.Item" href="\/admin\/mail"/);
  expect(page).toContain('href="/admin/mail/security"');
  expect(page).not.toContain("k2b-view-tabs");
  expect(page).not.toContain('aria-busy="true"');
});

test("a list the service cannot load says so, and a refused one is a 403", async () => {
  const server = app();
  spies.push(spyOn(kept, "listKeptConversations").mockResolvedValue(fail(err.internal("timeout"))));
  const page = await html(await server.request("/admin/mail/kept", { headers: { "Accept-Language": "de" } }));
  expect(page).toContain('data-k2-part="Failed"');
  expect(page).toContain("Aufbewahrte Unterhaltungen konnten nicht geladen werden");
  for (const spy of spies.splice(0)) spy.mockRestore();
  const refused = app();
  spies.push(spyOn(kept, "listKeptConversations").mockResolvedValue(fail(err.forbidden("no"))));
  expect((await refused.request("/admin/mail/kept")).status).toBe(403);
});

test("the record renders its messages, figures and history, and an unknown one says it is not kept", async () => {
  const server = app();
  const fixture = keptRecord();
  spies.push(
    spyOn(publicResources, "resolvePublicId").mockResolvedValue("mailbox-1"),
    spyOn(publicResources, "resolveMailboxPublicId").mockResolvedValue("conversation-1"),
    spyOn(kept, "getKeptConversation").mockResolvedValue({
      ok: true,
      data: {
        document: {
          schema: "cloud.mail.kept-conversations/v1",
          exportedAt: "2026-11-26T09:30:00.000Z",
          exportedBy: { label: "Ada Admin" },
          conversations: [fixture.conversation],
        },
        history: fixture.history,
        messageCount: fixture.messageCount,
        messagesTruncated: false,
      },
    }),
  );
  const page = await html(await server.request("/admin/mail/kept/Box001/Con001", { headers: { "Accept-Language": "de" } }));
  expect(page).toContain("Kündigung Mietvertrag Lindenstraße 14");
  expect(page).toContain('data-k2-part="Cells"');
  expect(page).toContain("Nicht gesendet (abgebrochen)");
  expect(page).toContain("wollte die Aufbewahrung aufheben (abgelehnt)");
  // the HTML message stands in a frame that runs nothing and loads nothing
  expect(page).toMatch(/<iframe[^>]*sandbox/);
  expect(page).not.toContain('aria-busy="true"');

  for (const spy of spies.splice(0)) spy.mockRestore();
  const missing = app();
  spies.push(spyOn(publicResources, "resolvePublicId").mockResolvedValue(null));
  const gone = await html(await missing.request("/admin/mail/kept/Box999/Con999", { headers: { "Accept-Language": "de" } }));
  expect(gone).toContain("Diese Unterhaltung wird nicht aufbewahrt oder existiert nicht mehr.");
});
