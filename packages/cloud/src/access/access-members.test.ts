import { describe, expect, test } from "bun:test";
import type { AccessMember } from "../contracts/shared";
import { accessMemberEntries } from "./access-members";

const jana = "11111111-1111-4111-8111-111111111111";
const team = "22222222-2222-4222-8222-222222222222";
const agent = "33333333-3333-4333-8333-333333333333";

const members: AccessMember[] = [
  { principal: { type: "user", userId: jana }, permission: "admin", displayName: "Jana Berger", avatarHash: "abc" },
  { principal: { type: "group", groupId: team }, permission: "write", displayName: "Lager-Team" },
  {
    principal: { type: "service_account", serviceAccountId: agent },
    permission: "read",
    displayName: "Inventur",
    serviceAccountKind: "agent",
  },
  { principal: { type: "authenticated" }, permission: "read" },
  { principal: { type: "public" }, permission: "read" },
  { principal: { type: "user", userId: team }, permission: "none", displayName: "Removed" },
];

describe("accessMemberEntries", () => {
  test("names every principal and its role in the access dialog's words, marking the viewer", () => {
    const entries = accessMemberEntries(members, { currentUserId: jana, locale: "en" });
    expect(entries.map((entry) => [entry.name, entry.kind, entry.role, entry.self ?? false])).toEqual([
      ["Jana Berger", "person", "Manage", true],
      ["Lager-Team", "group", "Edit", false],
      ["Inventur", "service", "View", false],
      ["All signed-in people", "everyone", "View", false],
      ["Public", "public", "View", false],
    ]);
    expect(entries[0]?.src).toBe(`/api/accounts/users/${jana}/avatar?rev=abc`);
    expect(entries[2]?.detail).toBe("Agent");
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
  });

  test("names service accounts by their kind, as the access dialog does", () => {
    const kinds = ["agent", "user_delegated", "resource_bound", "standalone"] as const;
    const entries = accessMemberEntries(
      kinds.map((kind, index) => ({
        principal: { type: "service_account", serviceAccountId: `${index}${agent.slice(1)}` },
        permission: "read",
        displayName: kind,
        serviceAccountKind: kind,
      })),
      { locale: "en" },
    );
    expect(entries.map((entry) => entry.detail)).toEqual(["Agent", "Personal", "API key", "Agent (API key only)"]);
  });

  test("speaks the request locale", () => {
    const entries = accessMemberEntries(members, { currentUserId: null, locale: "de" });
    expect(entries.map((entry) => entry.role)).toEqual(["Verwalten", "Bearbeiten", "Ansehen", "Ansehen", "Ansehen"]);
    expect(entries[3]?.name).toBe("Alle angemeldeten Personen");
  });
});
