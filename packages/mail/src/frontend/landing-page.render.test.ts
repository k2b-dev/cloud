import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import * as layoutHelp from "@k2b/cloud/ssr/help";
import { createConfig } from "@k2b/ssr";
import { err, fail, ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { selectHtml } from "../../../../tests/fixtures/select-html";
import { mailboxes, mailboxPreferences } from "../service";
import * as access from "../service/access";
import * as publicResources from "../service/public-resources";

const root = mkdtempSync(join(tmpdir(), "mail-landing-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "reader",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Test",
  sn: "Reader",
  displayName: "Test Reader",
  mail: "reader@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;
/** Internal and public IDs of four fictional mailboxes, in the order the mailbox list returns them. */
const boxes = [
  ["22222222-2222-4222-8222-222222222221", "Box001"],
  ["22222222-2222-4222-8222-222222222222", "Box002"],
  ["22222222-2222-4222-8222-222222222223", "Box003"],
  ["22222222-2222-4222-8222-222222222224", "Box004"],
] as const;
const publicIdOf = new Map<string, string>(boxes);
const internalIdOf = (shortId: string) => boxes.find(([, id]) => id === shortId)![0];
const listed = (shortIds: string[], permission: "read" | "none" = "read") =>
  shortIds.map((shortId) => ({
    id: internalIdOf(shortId),
    name: `Example ${shortId}`,
    description: null,
    health: "active" as const,
    healthReason: null,
    receivingAddress: null,
    syncEnabled: true,
    searchBackend: "auto" as const,
    automaticReplyManagementPermission: "admin" as const,
    accessScope: "mailbox" as const,
    composeSafety: { internalDomains: [], largeRecipientThreshold: 20 },
    createdAt: "2026-10-14T10:00:00Z",
    updatedAt: "2026-10-14T10:00:00Z",
    permission,
  }));

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
beforeEach(() => {
  spies.push(stubRailSnapshot());
  spies.push(spyOn(layoutHelp, "preloadLayoutHelp").mockResolvedValue(null));
  spies.push(spyOn(services.coreSettings, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(services, "get").mockResolvedValue("https://cloud.example.test"));
  // A mailbox outside the list is readable only where a test says so.
  spies.push(
    spyOn(publicResources, "resolveActiveMailboxId").mockImplementation(async (shortId) =>
      boxes.some(([, id]) => id === shortId) ? internalIdOf(shortId) : null,
    ),
    spyOn(access, "requireMailboxAccess").mockResolvedValue(fail(err.forbidden("Access denied"))),
  );
  spies.push(
    spyOn(publicResources, "publicIds").mockImplementation(
      async (_table, ids) =>
        new Map(ids.flatMap((id) => (typeof id === "string" && publicIdOf.has(id) ? [[id, publicIdOf.get(id)!] as const] : []))),
    ),
  );
});

const arrange = (input: { mailboxes?: string[]; denied?: string[]; pinned?: string[]; hidden?: string[] }) => {
  const list = spyOn(mailboxes, "listMailboxes").mockResolvedValue(
    ok([...listed(input.mailboxes ?? []), ...listed(input.denied ?? [], "none")]),
  );
  spies.push(
    list,
    spyOn(mailboxPreferences, "listMailboxPreferences").mockResolvedValue({
      pinnedMailboxIds: (input.pinned ?? []).map(internalIdOf),
      hiddenMailboxIds: (input.hidden ?? []).map(internalIdOf),
    }),
  );
  return list;
};

const request = (query = "", lastMailboxId: string | null = null, locale = "en", cookieLists: { pinnedMailboxIds?: string[] } = {}) => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("accessSubject", { type: "user", userId: user.id });
    c.set("credentialKind", "session");
    c.set("credentialScopes", []);
    c.set("runtime", {
      apps: [{ id: "mail", name: "Mail", icon: "ti ti-mail", description: "Fixture", routes: ["/app/mail"] }],
    });
    await next();
  });
  app.get("/app/mail", ...handler);
  const stored = { ...(lastMailboxId ? { lastMailboxId } : {}), ...cookieLists };
  const cookie = Object.keys(stored).length > 0 ? `cloud_mail_workspace=${encodeURIComponent(JSON.stringify(stored))}` : "";
  return app.request(`https://cloud.example.test/app/mail${query}`, {
    headers: { cookie, "accept-language": locale },
  });
};

const location = (response: Response) => {
  expect(response.status).toBe(302);
  return response.headers.get("location");
};

test("with exactly one mailbox, Mail opens it, also when it is hidden", async () => {
  arrange({ mailboxes: ["Box003"], denied: ["Box001"], hidden: ["Box003"] });
  expect(location(await request())).toBe("/app/mail/Box003");
});

test("with several mailboxes, Mail opens the last one this browser used", async () => {
  arrange({ mailboxes: ["Box001", "Box002", "Box003"], pinned: ["Box002"] });
  expect(location(await request("", "Box003"))).toBe("/app/mail/Box003");
});

test("a last mailbox that is hidden, no longer readable, or gone falls back to the first pinned one", async () => {
  arrange({ mailboxes: ["Box001", "Box002", "Box003"], denied: ["Box004"], pinned: ["Box002"], hidden: ["Box003"] });
  for (const last of ["Box003", "Box004", "Box009"]) expect(location(await request("", last))).toBe("/app/mail/Box002");
});

test("a last or pinned mailbox beyond the listed ones still opens while the person can read it", async () => {
  arrange({ mailboxes: ["Box001", "Box002"] });
  const readable = spyOn(access, "requireMailboxAccess").mockResolvedValue(ok({ permission: "read", scope: "mailbox" }));
  spies.push(readable);
  expect(location(await request("", "Box004"))).toBe("/app/mail/Box004");
  expect(readable).toHaveBeenCalledWith(expect.anything(), internalIdOf("Box004"), "read");
  readable.mockResolvedValue(fail(err.forbidden("Access denied")));
  expect(location(await request("", "Box004"))).toBe("/app/mail/Box001");
  // Pins hold only mailboxes the person can read, also beyond the list.
  spies.push(
    spyOn(mailboxPreferences, "listMailboxPreferences").mockResolvedValue({
      pinnedMailboxIds: [internalIdOf("Box003")],
      hiddenMailboxIds: [],
    }),
  );
  expect(location(await request())).toBe("/app/mail/Box003");
});

test("a failed move of a browser's old mailbox lists keeps the cookie and still opens a mailbox", async () => {
  arrange({ mailboxes: ["Box001", "Box002"] });
  spies.push(spyOn(mailboxPreferences, "importBrowserMailboxPreferences").mockRejectedValue(new Error("connection reset")));
  const response = await request("", "Box002", "en", { pinnedMailboxIds: ["Box001"] });
  expect(location(response)).toBe("/app/mail/Box002");
  expect(response.headers.get("set-cookie")).toBeNull();
});

test("without a last or pinned mailbox, Mail opens the first listed one that is shown", async () => {
  arrange({ mailboxes: ["Box001", "Box002", "Box003"], hidden: ["Box001"] });
  expect(location(await request())).toBe("/app/mail/Box002");
});

test("an old link to a conversation opens it in its mailbox without reading the mailbox list", async () => {
  const list = arrange({ mailboxes: ["Box001", "Box002"] });
  expect(location(await request("?mailbox=Box002&conversation=Conv01&view=waiting"))).toBe("/app/mail/Box002?conversation=Conv01");
  expect(location(await request("?mailbox=Box002"))).toBe("/app/mail/Box002");
  expect(list).not.toHaveBeenCalled();
});

test("an old Focus view opens the same view in the mailbox Mail opens", async () => {
  arrange({ mailboxes: ["Box001", "Box002"] });
  expect(location(await request("?view=waiting", "Box002"))).toBe("/app/mail/Box002?view=waiting");
  expect(location(await request("?view=mine&conversation=Conv01", "Box002"))).toBe("/app/mail/Box002?view=mine");
  // "All active" was Focus's widest view; the mailbox's default All tab replaces it.
  expect(location(await request("?view=all", "Box002"))).toBe("/app/mail/Box002");
  expect(location(await request("?view=nonsense&recent=true", "Box002"))).toBe("/app/mail/Box002");
});

test("without a mailbox, the page offers to create one", async () => {
  arrange({ denied: ["Box001"] });
  const response = await request();
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("No mailbox yet");
  expect(await selectHtml(html, ".mail-landing-workspace .mail-sidebar")).toHaveLength(1);
  expect(html).not.toContain("Mail could not open your mailboxes");
  expect(html).not.toContain("Focus");
});

test("a failed read shows the error with a way to retry, never the empty state", async () => {
  for (const failure of [
    () => spyOn(mailboxes, "listMailboxes").mockResolvedValue(fail(err.internal("Database unavailable"))),
    () => spyOn(mailboxes, "listMailboxes").mockRejectedValue(new Error("connection reset")),
  ]) {
    const list = failure();
    const preferences = spyOn(mailboxPreferences, "listMailboxPreferences").mockResolvedValue({
      pinnedMailboxIds: [],
      hiddenMailboxIds: [],
    });
    try {
      const response = await request("?view=waiting", "Box001");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Mail could not open your mailboxes");
      expect(html).not.toContain("No mailbox yet");
      expect(html).not.toContain("connection reset");
      expect(await selectHtml(html, ".mail-landing-workspace .mail-sidebar")).toHaveLength(0);
      // Retry asks for the same view again.
      expect((await selectHtml(html, 'a[href="/app/mail?view=waiting"]')).some((link) => link.text.includes("Retry"))).toBe(true);
    } finally {
      list.mockRestore();
      preferences.mockRestore();
    }
  }
});

test("the German page names the error and the retry in German", async () => {
  spies.push(
    spyOn(mailboxes, "listMailboxes").mockRejectedValue(new Error("connection reset")),
    spyOn(mailboxPreferences, "listMailboxPreferences").mockResolvedValue({ pinnedMailboxIds: [], hiddenMailboxIds: [] }),
  );
  const html = await (await request("", null, "de")).text();
  expect(html).toContain("Mail konnte deine Postfächer nicht öffnen");
  expect(html).toContain("Erneut versuchen");
});
