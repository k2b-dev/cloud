import { afterEach, expect, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { ok } from "@k2b/stdlib";
import { focus, type MailRequestContext, mailboxes, mailboxPreferences, publicResources } from "../service";
import { loadMailSidebarData } from "./mail-sidebar-data";

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "reader",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Test",
  sn: "Reader",
  displayName: "Test Reader",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const context: MailRequestContext = {
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  requestId: "sidebar-test",
};
const internal = "22222222-2222-4222-8222-222222222222";
const hidden = "33333333-3333-4333-8333-333333333333";
const denied = "44444444-4444-4444-8444-444444444444";
const mailbox = (id: string, permission: "read" | "none") => ({
  id,
  name: "Support",
  description: null,
  health: "active" as const,
  healthReason: null,
  receivingAddress: "support@example.test",
  syncEnabled: true,
  searchBackend: "auto" as const,
  automaticReplyManagementPermission: "admin" as const,
  accessScope: "mailbox" as const,
  composeSafety: { internalDomains: [], largeRecipientThreshold: 20 },
  createdAt: "2026-10-14T10:00:00Z",
  updatedAt: "2026-10-14T10:00:00Z",
  permission,
});
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
const publicIds = () =>
  spies.push(
    spyOn(publicResources, "publicIds").mockImplementation(async (_table, ids) => {
      const map = new Map([
        [internal, "Box001"],
        [hidden, "Box002"],
      ]);
      return new Map(ids.flatMap((id) => (id && map.has(id) ? [[id, map.get(id)!] as const] : [])));
    }),
  );

test("sidebar reads mailboxes and preferences concurrently and projects public IDs", async () => {
  publicIds();
  const list = Promise.withResolvers<Awaited<ReturnType<typeof mailboxes.listMailboxes>>>();
  const preferences = Promise.withResolvers<Awaited<ReturnType<typeof mailboxPreferences.listMailboxPreferences>>>();
  const readList = spyOn(mailboxes, "listMailboxes").mockReturnValue(list.promise);
  const readPreferences = spyOn(mailboxPreferences, "listMailboxPreferences").mockReturnValue(preferences.promise);
  spies.push(readList, readPreferences);
  const loading = loadMailSidebarData(context);
  try {
    expect(readList).toHaveBeenCalledWith(context, 200);
    expect(readPreferences).toHaveBeenCalledWith(context);
  } finally {
    list.resolve(ok([mailbox(internal, "read"), mailbox(hidden, "read"), mailbox(denied, "none")]));
    preferences.resolve({ pinnedMailboxIds: [internal], hiddenMailboxIds: [hidden] });
  }
  const result = await loading;
  expect(result.mailboxes.map((box) => box.id)).toEqual(["Box001", "Box002"]);
  expect(result.mailboxes[0]).toEqual({
    id: "Box001",
    name: "Support",
    health: "active",
    healthReason: null,
    receivingAddress: "support@example.test",
  });
  expect(result.pinnedMailboxIds).toEqual(["Box001"]);
  expect(result.hiddenMailboxIds).toEqual(["Box002"]);
});
test("mailbox sidebar never reads cross-mailbox Focus counts and still returns mailboxes, pins and hidden mailboxes", async () => {
  publicIds();
  spies.push(spyOn(mailboxes, "listMailboxes").mockResolvedValue(ok([mailbox(internal, "read"), mailbox(hidden, "read")])));
  spies.push(
    spyOn(mailboxPreferences, "listMailboxPreferences").mockResolvedValue({ pinnedMailboxIds: [internal], hiddenMailboxIds: [hidden] }),
  );
  const readCounts = spyOn(focus, "listMailboxCounts").mockResolvedValue(ok([]));
  spies.push(readCounts);
  const result = await loadMailSidebarData(context);
  expect(readCounts).not.toHaveBeenCalled();
  expect(result.mailboxes.map((box) => box.id)).toEqual(["Box001", "Box002"]);
  expect(result.pinnedMailboxIds).toEqual(["Box001"]);
  expect(result.hiddenMailboxIds).toEqual(["Box002"]);
});
