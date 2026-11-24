import { describe, expect, test } from "bun:test";
import { type AgentKey, agentKeyOpenFrom, agentKeySortFrom, agentPageHref, isAgentKeyExpired, sortAgentKeys } from "./agent-keys";

const key = (id: string, name: string, createdAt: string, lastUsedAt: string | null): AgentKey => ({
  id,
  name,
  tokenPrefix: "k2b_sa_0000",
  access: "full",
  createdAt,
  expiresAt: null,
  lastUsedAt,
});

const keys = [
  key("a", "laptop", "2026-09-22T09:20:00.000Z", "2026-11-24T18:02:00.000Z"),
  key("b", "Ärger-Skript", "2026-11-03T14:41:00.000Z", null),
  key("c", "Export 10", "2026-03-02T08:00:00.000Z", "2026-06-30T07:15:00.000Z"),
  key("d", "Export 9", "2026-03-02T08:00:00.000Z", null),
];
const ids = (sorted: AgentKey[]) => sorted.map((entry) => entry.id);

describe("an agent's keys in order", () => {
  test("newest first, ties by id, so a reload shows the same list", () => {
    expect(ids(sortAgentKeys(keys, "created", "de"))).toEqual(["b", "a", "c", "d"]);
  });
  test("by name in the reader's language, numbers as numbers", () => {
    expect(ids(sortAgentKeys(keys, "name", "de"))).toEqual(["b", "d", "c", "a"]);
  });
  test("by last use, never used at the end and newest first among them", () => {
    expect(ids(sortAgentKeys(keys, "used", "de"))).toEqual(["a", "c", "b", "d"]);
  });
  test("leaves the given list as it was", () => {
    sortAgentKeys(keys, "name", "de");
    expect(ids(keys)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("the address of an agent's page", () => {
  const agent = "0b2f5c7e-0000-4000-8000-0000000000bb";
  const keyId = "4D1E8A20-0000-4000-8000-000000000001";
  test("reads the order and what is open, and ignores anything else", () => {
    expect(agentKeySortFrom("name")).toBe("name");
    expect(agentKeySortFrom("bogus")).toBe("created");
    expect(agentKeySortFrom(undefined)).toBe("created");
    expect(agentKeyOpenFrom("new")).toEqual({ kind: "new" });
    expect(agentKeyOpenFrom(keyId)).toEqual({ kind: "key", id: keyId.toLowerCase() });
    expect(agentKeyOpenFrom("'; drop")).toEqual({ kind: "none" });
  });
  test("keeps the order when something opens and leaves out the default", () => {
    expect(agentPageHref(agent, { sort: "created" })).toBe(`/app/accounts/agents/${agent}`);
    expect(agentPageHref(agent, { sort: "used", open: "new" })).toBe(`/app/accounts/agents/${agent}?sort=used&key=new`);
  });
  test("an expired key is one whose end has passed", () => {
    const now = new Date("2026-11-24T12:00:00.000Z");
    expect(isAgentKeyExpired({ expiresAt: "2026-11-24T12:00:00.000Z" }, now)).toBe(true);
    expect(isAgentKeyExpired({ expiresAt: "2026-12-31T23:59:00.000Z" }, now)).toBe(false);
    expect(isAgentKeyExpired({ expiresAt: null }, now)).toBe(false);
  });
});
