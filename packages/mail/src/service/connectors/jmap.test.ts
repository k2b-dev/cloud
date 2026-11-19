import { afterEach, expect, test } from "bun:test";
import { discoverJmapFolders, JMAP_DISCOVERY_PAGES, type JmapMailboxRights, mapJmapRights, verifyJmap } from "./jmap";
import { JMAP_CORE, JMAP_MAIL, JMAP_SUBMISSION } from "./jmap-client";
import { createJmapFixture, fixtureMailbox, fixtureRights } from "./jmap-fixture";

const fixtures: ReturnType<typeof createJmapFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});
const fixture = () => {
  const value = createJmapFixture();
  fixtures.push(value);
  return value;
};
const access = (f: ReturnType<typeof fixture>) => ({
  origin: f.origin,
  authorization: "Basic ZmljdGlvbmFsOmZpeHR1cmU=",
  signal: new AbortController().signal,
});

test("verifies a writable primary mail account and returns core limits", async () => {
  const f = fixture();
  expect(await verifyJmap(access(f), f.dependencies)).toEqual({
    origin: f.origin,
    accountId: "d333333",
    name: "Example mailbox",
    username: "reader@example.invalid",
    limits: expect.objectContaining({ maxObjectsInGet: 2, maxCallsInRequest: 16 }),
  });
});

test("rejects missing mail/submission capabilities at session and account level", async () => {
  const f = fixture();
  for (const capability of [JMAP_MAIL, JMAP_SUBMISSION]) {
    f.controls.handle = () =>
      Response.json({
        ...f.session,
        capabilities: Object.fromEntries(Object.entries(f.session.capabilities).filter(([key]) => key !== capability)),
      });
    await expect(verifyJmap(access(f), f.dependencies)).rejects.toMatchObject({ code: "JMAP_CAPABILITY" });
    f.controls.handle = () =>
      Response.json({ ...f.session, accounts: { d333333: { ...f.session.accounts.d333333, accountCapabilities: {} } } });
    await expect(verifyJmap(access(f), f.dependencies)).rejects.toMatchObject({ code: "JMAP_CAPABILITY" });
  }
});

test("rejects a read-only, absent or non-primary account", async () => {
  const f = fixture();
  f.session.accounts.d333333.isReadOnly = true;
  await expect(verifyJmap(access(f), f.dependencies)).rejects.toMatchObject({ code: "JMAP_ACCOUNT" });
  f.session.accounts.d333333.isReadOnly = false;
  f.controls.handle = () => Response.json({ ...f.session, accounts: {} });
  await expect(verifyJmap(access(f), f.dependencies)).rejects.toMatchObject({ code: "JMAP_ACCOUNT" });
  f.controls.handle = () => Response.json({ ...f.session, primaryAccounts: {} });
  await expect(verifyJmap(access(f), f.dependencies)).rejects.toMatchObject({ code: "JMAP_ACCOUNT" });
  f.controls.handle = () => Response.json({ ...f.session, primaryAccounts: { [JMAP_MAIL]: "constructor" } });
  await expect(verifyJmap(access(f), f.dependencies)).rejects.toMatchObject({ code: "JMAP_ACCOUNT" });
});

const noRights = Object.fromEntries(Object.keys(fixtureRights).map((key) => [key, false]));
const rights = (values: Partial<JmapMailboxRights>): JmapMailboxRights => ({ ...fixtureRights, ...noRights, ...values });
for (const [values, expected] of [
  [{ mayReadItems: true }, ["read"]],
  [{ mayAddItems: true }, ["insert"]],
  [{ mayRemoveItems: true }, ["move", "delete_messages"]],
  [{ maySetSeen: true }, []],
  [{ maySetKeywords: true }, []],
  [{ maySetSeen: true, maySetKeywords: true }, ["write_flags"]],
  [{ mayCreateChild: true }, ["create_children"]],
  [{ mayRename: true }, []],
  [{ mayDelete: true }, []],
  [{ mayRename: true, mayDelete: true }, ["delete_folder"]],
  [{ maySubmit: true }, []],
] satisfies Array<[Partial<JmapMailboxRights>, string[]]>) {
  test(`maps rights narrowly: ${Object.keys(values).join(", ")}`, () => expect(mapJmapRights(rights(values))).toEqual(expected));
}

test("maps folder paths, subscription, roles and rights across query/get batches", async () => {
  const f = fixture();
  f.mailboxes.reverse(); // Child before parent, and in a different batch.
  f.mailboxes[0]!.isSubscribed = false;
  for (const role of ["sent", "drafts", "trash", "junk", "archive", "unknown"]) f.mailboxes.push(fixtureMailbox(role, role, null, role));
  const folders = await discoverJmapFolders(access(f), f.dependencies);
  expect(folders.find((folder) => folder.mailboxId === "c")).toMatchObject({
    path: "Projects/Example",
    parentPath: "Projects",
    name: "Example",
    subscribed: false,
    role: "other",
    uidValidity: null,
    uidNext: null,
    highestModseq: null,
    rightsSource: "acl",
  });
  expect(folders.find((folder) => folder.mailboxId === "a")).toMatchObject({ role: "inbox", rights: mapJmapRights(fixtureRights) });
  for (const role of ["sent", "drafts", "trash", "junk", "archive"] as const)
    expect(folders.find((folder) => folder.mailboxId === role)?.role).toBe(role);
  expect(folders.find((folder) => folder.mailboxId === "unknown")?.role).toBe("other");
  const calls = f.requests.flatMap((req) => req.calls ?? []);
  expect(calls.filter(([name]) => name === "Mailbox/get").map(([, args]) => args.ids)).toEqual([
    ["c", "b"],
    ["a", "sent"],
    ["drafts", "trash"],
    ["junk", "archive"],
    ["unknown"],
  ]);
});

test("empty account returns an empty folder list", async () => {
  const f = fixture();
  f.mailboxes.splice(0);
  expect(await discoverJmapFolders(access(f), f.dependencies)).toEqual([]);
});

for (const shape of ["cycle", "missing-parent", "slash", "duplicate-path", "invalid-id"] as const) {
  test(`rejects invalid folder data: ${shape}`, async () => {
    const f = fixture();
    if (shape === "cycle") f.mailboxes[1]!.parentId = "c";
    if (shape === "missing-parent") f.mailboxes[1]!.parentId = "absent";
    if (shape === "slash") f.mailboxes[1]!.name = "a/b";
    if (shape === "duplicate-path") f.mailboxes[1]!.name = "Inbox";
    if (shape === "invalid-id") f.mailboxes[1]!.id = "bad/id";
    await expect(discoverJmapFolders(access(f), f.dependencies)).rejects.toMatchObject({
      code: shape === "invalid-id" ? "JMAP_INVALID_RESPONSE" : "JMAP_FOLDER_TREE",
    });
  });
}

test("rejects repeated query IDs rather than continuing indefinitely", async () => {
  const f = fixture();
  f.controls.handle = async (request) =>
    request.method === "POST"
      ? Response.json({
          methodResponses: [
            ["Mailbox/query", { accountId: "d333333", queryState: "s", position: 0, total: 4, ids: ["a", "a"] }, "folders"],
          ],
          sessionState: "s",
        })
      : undefined;
  await expect(discoverJmapFolders(access(f), f.dependencies)).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
  expect(f.requests).toHaveLength(2);
});

test("reads 1,000 folders in batches with only the required properties", async () => {
  const f = fixture();
  f.session.capabilities[JMAP_CORE].maxObjectsInGet = 100;
  f.session.accounts.d333333.accountCapabilities[JMAP_MAIL]!.maxSizeMailboxName = 4_000;
  f.mailboxes.splice(
    0,
    f.mailboxes.length,
    ...Array.from({ length: 1_000 }, (_, i) => fixtureMailbox(`f${i}`, `${"界".repeat(990)} ${i}`)),
  );
  expect(await discoverJmapFolders(access(f), f.dependencies)).toHaveLength(1_000);
  // Each batch exceeds the ordinary 256 KiB budget; the object-derived budget admits it.
  expect(Buffer.byteLength(JSON.stringify(f.mailboxes.slice(0, 100)))).toBeGreaterThan(256 * 1024);
  const gets = f.requests.flatMap((request) => request.calls ?? []).filter(([name]) => name === "Mailbox/get");
  expect(gets).toHaveLength(10);
  for (const [, args] of gets) expect(args.properties).toEqual(["id", "name", "parentId", "role", "isSubscribed", "myRights"]);
});

test("bounds even a progressing query with an endless fabricated total", async () => {
  const f = fixture();
  let pages = 0;
  f.controls.handle = (request) =>
    request.method === "POST"
      ? Response.json({
          methodResponses: [
            [
              "Mailbox/query",
              {
                accountId: "d333333",
                queryState: "s",
                position: pages,
                total: 1_000_000,
                ids: [`f${pages++}`],
              },
              "folders",
            ],
          ],
          sessionState: "s",
        })
      : undefined;
  await expect(discoverJmapFolders(access(f), f.dependencies)).rejects.toMatchObject({ code: "JMAP_DISCOVERY_LIMIT" });
  expect(pages).toBe(JMAP_DISCOVERY_PAGES);
});

test("uses the advertised mailbox name size with a local ceiling", async () => {
  const f = fixture();
  f.session.accounts.d333333.accountCapabilities[JMAP_MAIL]!.maxSizeMailboxName = 8;
  f.mailboxes[0]!.name = "x".repeat(9);
  await expect(discoverJmapFolders(access(f), f.dependencies)).rejects.toMatchObject({ code: "JMAP_DISCOVERY_LIMIT" });
});
