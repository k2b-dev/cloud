import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { SQL, sql } from "bun";
import * as registry from "../_internal/registry";
import type { RequestAuthority } from "../server";
import * as users from "../services/accounts/users";
import * as appAccess from "../services/app-access";
import { buildProjectedUser } from "../services/session/user";
import { aiProjects } from "./projects";
import { aiSkills, type SkillRow } from "./skills";

const user = buildProjectedUser({ id: "11111111-1111-4111-8111-111111111111", provider: "local", profile: "user", effective_admin: false });
const authority: RequestAuthority = {
  actor: { kind: "user", user, sessionKind: "app" },
  accessSubject: { type: "user", userId: user.id },
  credentialKind: "oauth",
  scopes: ["core:read"],
};
const row: SkillRow = {
  id: "22222222-2222-4222-8222-222222222222",
  short_id: "sKi234",
  managed_key: null,
  name: "private-skill",
  description: "Private instructions.",
  instructions: "Do work.",
  extra_frontmatter: {},
  revision: 1,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};
const clients: SQL[] = [];
afterEach(async () => {
  mock.restore();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

test("every Skill mutation keeps the resolved authority and stops before effects when access is denied", async () => {
  const apps = [
    {
      id: "private",
      name: "Private",
      description: "Private",
      icon: "ti ti-lock",
      routes: [],
      baseUrl: "http://private.invalid",
      access: { kind: "signedIn" as const },
    },
  ];
  spyOn(registry, "listApps").mockResolvedValue(apps);
  const resolve = spyOn(appAccess, "usableAppIds").mockResolvedValue(new Set());
  const reloadRoles = spyOn(users, "getRoles").mockImplementation(async () => {
    throw new Error("Must keep effective phone roles");
  });
  const client = new SQL("postgres://localhost/unused_test");
  clients.push(client);
  const tx = Object.assign(
    new Proxy(client, {
      apply(_target, _receiver, [strings]) {
        const query = strings.join("?").replace(/\s+/g, " ").trim();
        if (query.startsWith("SELECT * FROM ai.skills") || query.startsWith("SELECT id FROM ai.skills")) return Promise.resolve([row]);
        if (query.endsWith("AS permission")) return Promise.resolve([{ permission: null }]);
        throw new Error(`Unexpected effect or query after denial: ${query}`);
      },
    }),
    {
      savepoint: async () => {
        throw new Error("Unexpected savepoint after denial");
      },
    },
  );
  spyOn(sql, "begin").mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected transaction callback");
    return run(tx);
  });
  spyOn(aiProjects, "get").mockResolvedValue({
    id: "33333333-3333-4333-8333-333333333333",
    shortId: "pRo234",
    name: "Project",
    permission: "admin",
    description: "",
    icon: "",
    instructions: "",
    defaultModel: null,
    revision: 1,
    createdAt: row.created_at.toString(),
    updatedAt: row.updated_at.toString(),
  });
  const subject = authority.accessSubject;
  const grantId = "gRa234";
  const content = { expectedRevision: 1, name: row.name, description: row.description, instructions: row.instructions };
  const results = [
    await aiSkills.update(row.id, subject, content, authority),
    await aiSkills.delete(row.id, subject, authority),
    await aiSkills.setReference(row.id, subject, { expectedRevision: 1, path: "references/a.md", content: "A" }, authority),
    await aiSkills.setReferences(
      row.id,
      subject,
      { expectedRevision: 1, references: [{ path: "references/a.md", content: "A" }] },
      authority,
    ),
    await aiSkills.removeReference(row.id, subject, { expectedRevision: 1, path: "references/a.md" }, authority),
    await aiSkills.setEnabled(row.id, subject, false, authority),
    await aiSkills.grantAccess(row.id, subject, { principal: { type: "authenticated" }, permission: "read" }, undefined, authority),
    await aiSkills.updateAccess(row.id, grantId, subject, "read", undefined, authority),
    await aiSkills.revokeAccess(row.id, grantId, subject, undefined, authority),
    await aiSkills.linkProject(row.id, "33333333-3333-4333-8333-333333333333", true, subject, authority),
  ];
  expect(results).toEqual([null, false, null, null, null, null, null, false, false, false]);
  expect(resolve).toHaveBeenCalledTimes(results.length);
  for (const [received, registered] of resolve.mock.calls) {
    expect(received).toBe(authority);
    expect(registered).toBe(apps);
  }
  expect(reloadRoles).not.toHaveBeenCalled();
});
