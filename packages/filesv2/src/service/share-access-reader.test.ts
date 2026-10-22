import { expect, test } from "bun:test";
import { actorId, historyFixture, otherId } from "../../test/activity-reader-fixture";
import { testActor, testCall } from "../../test/files-call";
import { ShareAccessInput } from "../activity-contracts";
import { createActivityReader } from "./activity-reader";

const input = { shareId: "50000000-0000-4000-8000-000000000001", from: "2030-04-01", to: "2030-05-15" };
const call = testCall(testActor);

test.each(["192.0.2.0/24", "0.0.0.0/24", "255.255.255.0/24", "2001:db8:abcd::/48", "::/48", "0:0:1::/48"])(
  "share network pagination accepts canonical masked key %s",
  (networkAfter) => {
    expect(ShareAccessInput.parse({ ...input, networkAfter }).networkAfter).toBe(networkAfter);
  },
);

test.each([
  "*",
  "unknown",
  "192.0.2.231",
  "192.0.2.231/24",
  "192.0.2.0/32",
  "192.000.2.0/24",
  "2001:db8:abcd:1234::/48",
  "2001:0DB8:abcd::/48",
  "2001:db8:abcd:0:0:0:0:0/48",
  "2001:db8::/64",
  "invalid",
  "a".repeat(44),
])("share network pagination rejects raw, sentinel and noncanonical key %s", (networkAfter) => {
  expect(ShareAccessInput.safeParse({ ...input, networkAfter }).success).toBe(false);
});

test("share input bounds pages and inclusive UTC dates and rejects a transport clock", () => {
  expect(ShareAccessInput.parse(input).networkLimit).toBe(50);
  for (const networkLimit of [0, -1, 51, 1.5]) expect(ShareAccessInput.safeParse({ ...input, networkLimit }).success).toBe(false);
  expect(ShareAccessInput.parse({ ...input, networkLimit: 3 }).networkLimit).toBe(3);
  expect(ShareAccessInput.safeParse({ ...input, from: "2030-05-16" }).success).toBe(false);
  const from = "2020-01-01";
  const end = (days: number) => new Date(Date.parse(from) + days * 86_400_000).toISOString().slice(0, 10);
  expect(ShareAccessInput.safeParse({ ...input, from, to: end(3649) }).success).toBe(true);
  expect(ShareAccessInput.safeParse({ ...input, from, to: end(3650) }).success).toBe(false);
  expect(ShareAccessInput.safeParse({ ...input, now: "2030-05-15" }).success).toBe(false);
});

test("share access gates every page before querying, using only creator or canonical admin", async () => {
  const f = historyFixture();
  let creator = otherId;
  let exists = true;
  let queries = 0;
  const now = new Date("2030-05-15T12:30:00Z");
  const original = f.deps.data!.shareAccess;
  const reader = createActivityReader({
    ...f.deps,
    now: () => now,
    requestContext: async () => {
      throw new Error("Share counts must not load file membership/configuration");
    },
    shares: { get: async () => (exists ? { created_by: creator } : null) },
    data: {
      ...f.deps.data!,
      shareAccess: async (parsed, options) => {
        queries++;
        expect(options?.now).toEqual(now);
        expect(parsed.networkLimit).toBe(3);
        return original(parsed, options);
      },
    },
  });
  const page = { ...input, networkLimit: 3, networkAfter: "192.0.2.0/24" };
  await expect(reader.shareAccess(call, page)).rejects.toMatchObject({ status: 404 });
  expect(queries).toBe(0);
  f.setAdmin(true);
  expect((await reader.shareAccess(call, page)).pages).toBe(5);
  f.setAdmin(false);
  await expect(reader.shareAccess(call, page)).rejects.toMatchObject({ status: 404 });
  creator = actorId;
  f.setMember(false);
  expect((await reader.shareAccess(call, page)).pages).toBe(5);
  expect(queries).toBe(2);
  exists = false;
  await expect(reader.shareAccess(call, page)).rejects.toMatchObject({ status: 404 });
  expect(queries).toBe(2);
});
