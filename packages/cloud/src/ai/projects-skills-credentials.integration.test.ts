import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { Hono } from "hono";
import { z } from "zod";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import type { AuthContext } from "../server";
import { useRegisteredTestApp } from "../services/identity/application.test-fixture";
import { serviceAccountCredentials } from "../services/service-account-credentials";
import { type ServiceAccountKind, serviceAccounts } from "../services/service-accounts";
import { createTestSession } from "../services/session/session.test-fixture";
import { migrateCloudAi } from "./migrate";
import { AiProjectLastAdminError, aiProjects } from "./projects";
import { aiProjectsRoutes } from "./projects-routes";
import { AiSkillLastAdminError, aiSkills } from "./skills";
import { aiSkillsRoutes } from "./skills-routes";

const suite = suiteFor("database", "nats", "valkey");
const server = new Hono<AuthContext>().route("/projects", aiProjectsRoutes).route("/skills", aiSkillsRoutes);
const ResourceSchema = z.object({ id: z.string(), permission: z.enum(["read", "write", "admin"]), revision: z.number() });
const ResourceResponseSchema = z.object({ project: ResourceSchema.optional(), skill: ResourceSchema.optional() });
const GrantSchema = z.object({
  id: z.string(),
  principal: z.object({ type: z.literal("service_account"), serviceAccountId: z.string() }),
  permission: z.enum(["read", "write", "admin"]),
  displayName: z.string(),
  serviceAccountKind: z.enum(["standalone", "agent", "user_delegated", "resource_bound"]),
});
const AccessListSchema = z.object({ access: z.array(z.object({ id: z.string(), principal: z.object({ type: z.string() }) })) });
type Resource = "projects" | "skills";

const request = (headers: Record<string, string>, path: string, method = "GET", body?: unknown) =>
  server.request(`https://cloud.example.test${path}`, {
    method,
    headers: {
      "x-forwarded-for": uniqueCallerAddress(),
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const fields = (resource: Resource) =>
  resource === "projects"
    ? { name: "Credential project", description: "Original", icon: "ti ti-book", instructions: "Keep original instructions" }
    : { name: `credential-${crypto.randomUUID()}`, description: "Original", instructions: "Original instructions" };
const readResource = async (response: Response) => {
  const result = ResourceResponseSchema.parse(await response.json());
  const resource = result.project ?? result.skill;
  if (!resource) throw new Error("Missing resource response");
  return resource;
};

suite("Project and Skill credential limits and manager eligibility", () => {
  useRegisteredTestApp("core", { kind: "signedIn" });
  const users: string[] = [];
  const accounts: string[] = [];
  const resources: { resource: Resource; id: string }[] = [];
  const owner = async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${`ai-credential-${crypto.randomUUID()}`}, 'local', 'user', 'AI test owner') RETURNING id
    `;
    if (!row) throw new Error("Missing owner fixture");
    users.push(row.id);
    return { id: row.id, headers: { cookie: `session_token=${await createTestSession(row.id)}` } };
  };
  const account = async (kind: ServiceAccountKind, userId: string, resource: Resource, resourceId: string) => {
    const name = `AI credential ${kind} ${crypto.randomUUID()}`;
    const bound = kind === "resource_bound";
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.service_accounts (name, kind, delegated_user_id, app_id, resource_type, resource_id)
      VALUES (${name}, ${kind}, ${kind === "user_delegated" ? userId : null}::uuid,
        ${bound ? "assistant" : null}, ${bound ? resource.slice(0, -1) : null}, ${bound ? resourceId : null}) RETURNING id
    `;
    if (!row) throw new Error("Missing account fixture");
    accounts.push(row.id);
    const token = async (scopes: string[]) => {
      const result = await serviceAccountCredentials.createApiToken({ serviceAccountId: row.id, name: "AI test token", scopes });
      if (!result.ok) throw new Error(result.error.message);
      return { authorization: `Bearer ${result.data.token}` };
    };
    const context = async (scopes: string[]) => {
      const serviceAccount = await serviceAccounts.get({ id: row.id });
      if (!serviceAccount) throw new Error("Missing machine account");
      return {
        actor: { kind: "service_account" as const, serviceAccount, delegatedUser: null, scopes },
        accessSubject: { type: "service_account" as const, serviceAccountId: row.id },
      };
    };
    return { id: row.id, name, token, context };
  };
  const create = async (resource: Resource, headers: Record<string, string>) => {
    const input = fields(resource);
    const response = await request(headers, `/${resource}`, "POST", input);
    expect(response.status).toBe(201);
    const result = await readResource(response);
    resources.push({ resource, id: result.id });
    return { ...result, input, path: `/${resource}/${result.id}` };
  };
  const grant = async (headers: Record<string, string>, path: string, serviceAccountId: string) => {
    const response = await request(headers, `${path}/access`, "POST", {
      principal: { type: "service_account", serviceAccountId },
      permission: "admin",
    });
    expect(response.status).toBe(201);
    return z.object({ access: GrantSchema }).parse(await response.json()).access;
  };
  const ownerEntry = async (headers: Record<string, string>, path: string) => {
    const response = await request(headers, `${path}/access`);
    expect(response.status).toBe(200);
    const entry = AccessListSchema.parse(await response.json()).access.find((entry) => entry.principal.type === "user");
    if (!entry) throw new Error("Missing owner access");
    return entry.id;
  };
  const mutate = async (
    resource: Resource,
    fixture: Awaited<ReturnType<typeof create>>,
    headers: Record<string, string>,
    description: string,
  ) => {
    const current = await request(headers, fixture.path);
    expect(current.status).toBe(200);
    const { revision } = await readResource(current);
    return request(
      headers,
      fixture.path,
      resource === "projects" ? "PATCH" : "PUT",
      resource === "projects" ? { description } : { ...fixture.input, description, expectedRevision: revision },
    );
  };

  beforeAll(async () => {
    await migrateCloudAi();
  });
  afterAll(async () => {
    for (const entry of resources) {
      if (entry.resource === "projects") {
        const project = await aiProjects.admin.getByShortId(entry.id);
        if (project) await aiProjects.admin.delete(project.id);
      } else {
        const skill = await aiSkills.admin.getByShortId(entry.id);
        if (skill) await aiSkills.admin.delete(skill.id);
      }
    }
    for (const id of accounts) {
      await sql`DELETE FROM audit.events WHERE target_id = ${id} OR actor_uid = ${id} OR metadata->>'serviceAccountId' = ${id}`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    }
    for (const id of users) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  for (const resource of ["projects", "skills"] as const) {
    for (const kind of ["standalone", "agent"] as const) {
      test(`${resource}: ${kind} authenticates, receives named grants, is scope-capped and loses revoked access`, async () => {
        const person = await owner();
        const fixture = await create(resource, person.headers);
        const machine = await account(kind, person.id, resource, fixture.id);
        const admin = await machine.token(["openid", "admin"]);
        const write = await machine.token(["openid", "write"]);
        const read = await machine.token(["openid", "read"]);
        const noAccess = await machine.token(["openid"]);
        expect((await request(admin, fixture.path)).status).toBe(404);
        const access = await grant(person.headers, fixture.path, machine.id);
        expect(access).toMatchObject({ displayName: machine.name, serviceAccountKind: kind });
        const listed = await request(resource === "skills" ? person.headers : admin, `${fixture.path}/access`);
        expect(listed.status).toBe(200);
        expect(await listed.json()).toMatchObject({
          access: expect.arrayContaining([expect.objectContaining({ id: access.id, displayName: machine.name, serviceAccountKind: kind })]),
        });
        for (const [headers, permission] of [
          [admin, "admin"],
          [write, "write"],
          [read, "read"],
        ] as const) {
          const response = await request(headers, fixture.path);
          expect(response.status).toBe(200);
          expect((await readResource(response)).permission).toBe(permission);
          const list = await request(headers, `/${resource}`);
          expect(list.status).toBe(200);
          expect(await list.json()).toMatchObject({
            [resource]: expect.arrayContaining([expect.objectContaining({ id: fixture.id, permission })]),
          });
        }
        expect((await request(noAccess, fixture.path)).status).toBe(404);
        expect(await (await request(noAccess, `/${resource}`)).json()).toMatchObject({ [resource]: [] });
        if (resource === "skills") {
          // HTTP management remains user-backed; machine service calls retain the credential cap.
          for (const headers of [read, write, admin]) {
            expect((await mutate(resource, fixture, headers, "Machine HTTP write")).status).toBe(403);
            expect((await request(headers, `${fixture.path}/access`)).status).toBe(403);
            expect((await request(headers, `${fixture.path}/access/${access.id}`, "DELETE")).status).toBe(403);
            expect((await request(headers, fixture.path, "DELETE")).status).toBe(403);
            expect((await request(headers, "/skills", "POST", fields(resource))).status).toBe(403);
          }
          const skill = await aiSkills.admin.getByShortId(fixture.id);
          if (!skill) throw new Error("Missing Skill");
          const content = { ...skill, description: "Machine service update", expectedRevision: skill.revision };
          expect(await aiSkills.update(skill.id, await machine.context(["read"]), content)).toBeNull();
          const updated = await aiSkills.update(skill.id, await machine.context(["write"]), content);
          expect(updated).toMatchObject({ description: content.description, permission: "write", revision: skill.revision + 1 });
          expect(await aiSkills.update(skill.id, await machine.context(["admin"]), { ...content, expectedRevision: updated!.revision })).not.toBeNull();
          for (const permission of ["write", "admin"] as const) {
            const created = await aiSkills.create({ subject: await machine.context([permission]), ...fields("skills") });
            resources.push({ resource: "skills", id: created.shortId });
            expect(created.permission).toBe(permission);
          }
          expect((await request(person.headers, `${fixture.path}/access/${access.id}`, "DELETE")).status).toBe(200);
          expect((await request(admin, fixture.path)).status).toBe(404);
          expect(await aiSkills.get(skill.id, await machine.context(["admin"]))).toBeNull();
          expect(await aiSkills.update(skill.id, await machine.context(["admin"]), content)).toBeNull();
          return;
        }
        expect((await mutate(resource, fixture, read, "Read must not write")).status).toBe(404);
        expect((await mutate(resource, fixture, write, "Write succeeds")).status).toBe(200);
        expect((await mutate(resource, fixture, admin, "Admin succeeds")).status).toBe(200);
        if (resource === "projects") {
          expect(await (await request(read, fixture.path)).json()).toMatchObject({
            project: { description: "Admin succeeds", icon: "ti ti-book", instructions: "Keep original instructions" },
          });
          expect((await request(write, fixture.path, "PATCH", { instructions: "Write must not change instructions" })).status).toBe(404);
        }
        for (const headers of [read, write]) {
          expect((await request(headers, `${fixture.path}/access`)).status).toBe(404);
          expect(
            (
              await request(headers, `${fixture.path}/access`, "POST", {
                principal: { type: "authenticated" },
                permission: "admin",
              })
            ).status,
          ).toBe(404);
          expect((await request(headers, `${fixture.path}/access/${access.id}`, "PATCH", { permission: "read" })).status).toBe(404);
          expect((await request(headers, `${fixture.path}/access/${access.id}`, "DELETE")).status).toBe(404);
          expect((await request(headers, fixture.path, "DELETE")).status).toBe(404);
        }
        expect((await request(read, `/${resource}`, "POST", fields(resource))).status).toBe(403);
        const created = await create(resource, admin);
        expect(created.permission).toBe("admin");
        expect((await create(resource, write)).permission).toBe("write");
        if (resource === "projects") {
          const knowledge = { title: "Machine knowledge", content: "Saved through its own credential" };
          expect((await request(read, `${fixture.path}/knowledge`, "POST", knowledge)).status).toBe(404);
          expect((await request(write, `${fixture.path}/knowledge`, "POST", knowledge)).status).toBe(201);
          const file = { path: "machine.txt", content: "Machine content", encoding: "utf8" };
          expect((await request(read, `${fixture.path}/files`, "POST", file)).status).toBe(404);
          const uploaded = await request(write, `${fixture.path}/files`, "POST", file);
          expect(uploaded.status).toBe(201);
          const { file: stored } = z.object({ file: z.object({ id: z.string() }) }).parse(await uploaded.json());
          const downloaded = await request(read, `${fixture.path}/files/${stored.id}`);
          expect(downloaded.status).toBe(200);
          expect(await downloaded.json()).toMatchObject({ content: Buffer.from("Machine content").toString("base64"), encoding: "base64" });
        }
        expect((await request(person.headers, `${fixture.path}/access/${access.id}`, "DELETE")).status).toBe(200);
        expect((await request(admin, fixture.path)).status).toBe(404);
        expect((await request(read, fixture.path)).status).toBe(404);
        expect((await request(admin, `${fixture.path}/access`)).status).toBe(404);
        expect(
          (
            await request(
              admin,
              fixture.path,
              resource === "projects" ? "PATCH" : "PUT",
              resource === "projects" ? { description: "Revoked" } : { ...fixture.input, expectedRevision: 1 },
            )
          ).status,
        ).toBe(404);
        if (resource === "projects") expect((await request(admin, `${fixture.path}/files`)).status).toBe(404);
        const after = await request(admin, `/${resource}`);
        expect(JSON.stringify(await after.json())).not.toContain(fixture.id);
      });
    }

    test(`${resource}: resource-bound credentials fail closed even with a plausible binding and an admin grant`, async () => {
      const person = await owner();
      const fixture = await create(resource, person.headers);
      const machine = await account("resource_bound", person.id, resource, fixture.id);
      const headers = await machine.token(["openid", "admin"]);
      await grant(person.headers, fixture.path, machine.id);
      expect((await request(headers, fixture.path)).status).toBe(404);
      expect(await (await request(headers, `/${resource}`)).json()).toMatchObject({ [resource]: [] });
      expect((await request(headers, `${fixture.path}/access`)).status).toBe(resource === "skills" ? 403 : 404);
      expect((await request(headers, `/${resource}`, "POST", fields(resource))).status).toBe(403);
    });

    test(`${resource}: delegated credentials retain the user's access and do not use their direct account grant`, async () => {
      const person = await owner();
      const fixture = await create(resource, person.headers);
      const machine = await account("user_delegated", person.id, resource, fixture.id);
      const headers = await machine.token(["openid", "read"]);
      expect((await request(headers, fixture.path)).status).toBe(200);
      expect((await mutate(resource, fixture, headers, "Delegated user writes")).status).toBe(200);
    });

    for (const kind of ["standalone", "agent", "user_delegated", "resource_bound"] as const) {
      test(`${resource}: ${kind} ${kind === "standalone" || kind === "agent" ? "can" : "cannot"} replace the last eligible manager`, async () => {
        const person = await owner();
        const fixture = await create(resource, person.headers);
        const machine = await account(kind, person.id, resource, fixture.id);
        const headers = await machine.token(["openid", "admin"]);
        const machineAccess = await grant(person.headers, fixture.path, machine.id);
        const ownerId = await ownerEntry(person.headers, fixture.path);
        const eligible = kind === "standalone" || kind === "agent";
        const status = eligible ? 200 : 409;
        expect((await request(person.headers, `${fixture.path}/access/${ownerId}`, "PATCH", { permission: "read" })).status).toBe(status);
        if (eligible && resource === "skills") {
          const skill = await aiSkills.admin.getByShortId(fixture.id);
          if (!skill) throw new Error("Missing Skill");
          const identity = await machine.context(["admin"]);
          expect((await request(headers, `${fixture.path}/access`)).status).toBe(403);
          expect(await aiSkills.updateAccess(skill.id, ownerId, identity, "admin")).toBe(true);
          expect((await request(person.headers, `${fixture.path}/access/${ownerId}`, "DELETE")).status).toBe(200);
          expect(await aiSkills.listAccess(skill.id, identity)).not.toBeNull();
          await expect(aiSkills.updateAccess(skill.id, machineAccess.id, identity, "read")).rejects.toBeInstanceOf(AiSkillLastAdminError);
          await expect(aiSkills.revokeAccess(skill.id, machineAccess.id, identity)).rejects.toBeInstanceOf(AiSkillLastAdminError);
          return;
        }
        if (eligible) {
          // The remaining machine manager can restore the person and then revoke that grant.
          expect((await request(headers, `${fixture.path}/access/${ownerId}`, "PATCH", { permission: "admin" })).status).toBe(200);
        }
        expect((await request(person.headers, `${fixture.path}/access/${ownerId}`, "DELETE")).status).toBe(status);
        if (eligible) {
          expect((await request(headers, `${fixture.path}/access`)).status).toBe(200);
          expect((await request(headers, `${fixture.path}/access/${machineAccess.id}`, "PATCH", { permission: "read" })).status).toBe(409);
          expect((await request(headers, `${fixture.path}/access/${machineAccess.id}`, "DELETE")).status).toBe(409);
        } else if (resource === "projects") {
          const project = await aiProjects.admin.getByShortId(fixture.id);
          if (!project) throw new Error("Missing Project");
          await expect(aiProjects.admin.updateAccess(project.id, ownerId, "read")).rejects.toBeInstanceOf(AiProjectLastAdminError);
          await expect(aiProjects.admin.revokeAccess(project.id, ownerId)).rejects.toBeInstanceOf(AiProjectLastAdminError);
        } else {
          const skill = await aiSkills.admin.getByShortId(fixture.id);
          if (!skill) throw new Error("Missing Skill");
          await expect(aiSkills.admin.updateAccess(skill.id, ownerId, "read")).rejects.toBeInstanceOf(AiSkillLastAdminError);
          await expect(aiSkills.admin.revokeAccess(skill.id, ownerId)).rejects.toBeInstanceOf(AiSkillLastAdminError);
        }
      });
    }
  }

  test("direct service paths require credential context for machine subjects and cap it on both resources", async () => {
    const person = await owner();
    const project = await create("projects", person.headers);
    const skill = await create("skills", person.headers);
    const machine = await account("agent", person.id, "projects", project.id);
    await grant(person.headers, project.path, machine.id);
    await grant(person.headers, skill.path, machine.id);
    const serviceAccount = await serviceAccounts.get({ id: machine.id });
    if (!serviceAccount) throw new Error("Missing account");
    const accessSubject = { type: "service_account" as const, serviceAccountId: machine.id };
    const subject = { actor: { kind: "service_account" as const, serviceAccount, delegatedUser: null, scopes: ["read"] }, accessSubject };
    const projectRow = await aiProjects.admin.getByShortId(project.id);
    const skillRow = await aiSkills.admin.getByShortId(skill.id);
    if (!projectRow || !skillRow) throw new Error("Missing resources");
    expect(await Reflect.apply(aiProjects.getByShortId, aiProjects, [project.id, accessSubject])).toBeNull();
    expect(await Reflect.apply(aiSkills.getByShortId, aiSkills, [skill.id, accessSubject])).toBeNull();
    expect((await aiProjects.getByShortId(project.id, subject))?.permission).toBe("read");
    expect((await aiSkills.getByShortId(skill.id, subject))?.permission).toBe("read");
    expect(await aiProjects.update(projectRow.id, subject, { description: "Blocked" })).toBeNull();
    expect(await aiProjects.createKnowledge(projectRow.id, subject, { title: "Blocked", content: "Blocked" })).toBeNull();
    expect(
      await aiProjects.writeFile(projectRow.id, subject, { path: "blocked.txt", mediaType: "text/plain", bytes: new Uint8Array() }),
    ).toBeNull();
    expect(
      await aiSkills.setReference(skillRow.id, subject, {
        path: "references/blocked.md",
        content: "Blocked",
        expectedRevision: skillRow.revision,
      }),
    ).toBeNull();
    expect(await aiProjects.snapshot(projectRow.id, subject)).not.toBeNull();
    const mismatch = { ...subject, accessSubject: { type: "service_account" as const, serviceAccountId: crypto.randomUUID() } };
    expect(await aiProjects.get(projectRow.id, mismatch)).toBeNull();
    expect(await aiSkills.get(skillRow.id, mismatch)).toBeNull();
    // Scopes never promote a legacy `none` entry into a readable grant, including SQL lists.
    await sql`UPDATE auth.access SET permission = 'none' WHERE service_account_id = ${machine.id}::uuid`;
    expect(await aiProjects.get(projectRow.id, subject)).toBeNull();
    expect(await aiSkills.get(skillRow.id, subject)).toBeNull();
    expect(await aiProjects.list(subject)).toEqual([]);
    expect(await aiSkills.list(subject)).toEqual([]);
  });
});
