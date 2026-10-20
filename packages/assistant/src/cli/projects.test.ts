import { expect, test } from "bun:test";
import type { AiProjectAccess } from "@k2b/cloud/ai";
import { projectAccessRows } from "./projects";

const entry = (principal: AiProjectAccess["principal"], displayName?: string): AiProjectAccess => ({
  id: "11111111-1111-4111-8111-111111111111",
  shortId: "grant",
  principal,
  permission: "read",
  displayName,
  createdAt: "2026-10-20T12:00:00.000Z",
});

test("project access rows name audiences and missing people for people, never by type or ID", () => {
  const userId = "22222222-2222-4222-8222-222222222222";
  const rows = projectAccessRows(
    [entry({ type: "authenticated" }), entry({ type: "user", userId }), entry({ type: "user", userId }, "Ada Example")],
    "de",
  );
  expect(rows.map((row) => row.principal)).toEqual(["Alle Benutzer einschließlich Gäste", "Unbekannte Person", "Ada Example"]);
});
