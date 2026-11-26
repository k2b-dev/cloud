import { describe, expect, test } from "bun:test";
import { agentRecordHref, legacyAgentHref } from "./agent-keys";

describe("the address of an agent's record", () => {
  const agent = "0b2f5c7e-0000-4000-8000-0000000000bb";
  test("an agent lives in the one account record", () => {
    expect(agentRecordHref(agent)).toBe(`/app/accounts/users/${agent}`);
  });
  test("an agent's page from before leads to its record; its keys open in the record's key section", () => {
    const at = (query: string) => legacyAgentHref(agent, new URLSearchParams(query));
    expect(at("")).toBe(`/app/accounts/users/${agent}`);
    expect(at("sort=name&key=new&page=3")).toBe(`/app/accounts/users/${agent}`);
    expect(at("key=4d1e8a20-0000-4000-8000-000000000001")).toBe(`/app/accounts/users/${agent}`);
  });
});
