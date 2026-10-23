import { expect, spyOn, test } from "bun:test";
import { type AuthContext, auth, createAccess, deleteAccess } from "@k2b/cloud/server";
import { serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import { sql } from "bun";
import { Hono } from "hono";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { CodeHostBusyError } from "../cli/code-host";
import { app as assistantApp } from "../config";
import { artifactDatabase } from "./database";
import { createMachineRoutes } from "./machine-api";
import { MachineRights } from "./machine-contracts";
import { activeMachineHosts, createMachineHostRoutes, executeMachine } from "./machine-execution";
import * as machineService from "./machine-service";
import { machineAccess, machineHttp } from "./machine-service";
import { type ArtifactIdentity, artifacts } from "./service";

/** Added to the existing disposable Assistant schema, never the development database. */
export async function machineFixtureSchema() {
  await sql`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS mail text`;
  await sql`CREATE TABLE auth.service_accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,kind text,status text DEFAULT 'active',
    delegated_user_id uuid,app_id text,resource_type text,resource_id text,created_by uuid,created_at timestamptz DEFAULT now())`;
  await sql`CREATE TABLE auth.service_account_credentials(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),service_account_id uuid REFERENCES auth.service_accounts(id),
    name text,kind text DEFAULT 'api_token',status text DEFAULT 'active',token_prefix text UNIQUE,secret_hash text,scopes text[] DEFAULT '{}',
    expires_at timestamptz,last_used_at timestamptz,created_by uuid,created_at timestamptz DEFAULT now(),revoked_at timestamptz,revoked_by uuid)`;
}

export function machineIntegrationCases(owner: ArtifactIdentity) {
  // Uses the production authentication middleware and route handlers. Rate-limit
  // infrastructure is independently covered by platform tests.
  const router = new Hono<AuthContext>().use("*", auth.requireRole("authenticated")).route("/", createMachineRoutes());
  const source = {
    entry: "main.ts",
    files: [
      {
        path: "main.ts",
        content: `export default async () => {
    await cloud.kv.set("machine-result", 42);
    await cloud.files.write("machine.txt", "machine output");
    return { value: await cloud.kv.get("machine-result"), file: await (await cloud.files.read("machine.txt")).text(), user: cloud.user };
  }`,
      },
      { path: "action.ts", content: "export default (input) => ({ doubled: input.value * 2 })" },
      {
        path: "app.actions.json",
        content: JSON.stringify({
          actions: [
            {
              name: "double",
              title: "Double",
              description: "Double a number",
              entry: "action.ts",
              inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },
              outputSchema: { type: "object", properties: { doubled: { type: "number" } }, required: ["doubled"] },
            },
          ],
        }),
      },
    ],
  };
  const call = (token: string, id: string, path: string, body?: unknown) =>
    router.request(`/${id}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const request = () => ({ requestId: crypto.randomUUID(), createdAt: Date.now(), publishedVersion: 1 });

  test.each(["agent", "standalone"] as const)(
    "%s token: explicit Studio execution, scope/resource ceilings and immediate revocation",
    async (kind) => {
      const created = await serviceAccounts.createStandalone({ name: `Studio ${kind} ${crypto.randomUUID()}`, kind });
      if (!created.ok) throw new Error("Machine fixture creation failed");
      const account = created.data;
      const token = await serviceAccountCredentials.createApiToken({
        serviceAccountId: account.id,
        name: "Studio write",
        scopes: ["write"],
      });
      const readToken = await serviceAccountCredentials.createApiToken({
        serviceAccountId: account.id,
        name: "Studio read",
        scopes: ["read"],
      });
      if (!token.ok || !readToken.ok) throw new Error("Token fixture creation failed");
      const app = await artifacts.create({ title: "Machine fixture", source }, owner);
      await artifacts.publish(app.id, app.revision, owner, "Machine fixture publication");
      const other = await artifacts.create({ title: "Other machine fixture", source }, owner);
      await artifacts.publish(other.id, other.revision, owner, "Other publication");
      expect((await call(token.data.token, app.id, "source")).status).toBe(403);
      expect((await call(token.data.token, app.id, "execute", request())).status).toBe(403);
      // Broad authenticated and Project access never supplies a direct machine grant.
      const broad = await artifacts.grant(app.id, { type: "authenticated" }, "read", owner);
      expect((await call(token.data.token, app.id, "execute", request())).status).toBe(403);
      if (broad) await artifacts.changeGrant(app.id, broad.id, null, owner);
      const grant = await artifacts.grant(app.id, { type: "service_account", serviceAccountId: account.id }, "read", owner);
      if (!grant) throw new Error("Missing grant");
      expect((await call(readToken.data.token, app.id, "source")).status).toBe(200);
      expect((await call(token.data.token, app.id, "execute", request())).status).toBe(403);
      const rights = await machineAccess.save(
        app.id,
        grant.id,
        { rights: MachineRights.parse({ execute: true, storage: "write" }), expectedRevision: null },
        owner,
      );
      expect((await call(readToken.data.token, app.id, "execute", request())).status).toBe(403);
      const duplicate = await createAccess({ principal: { type: "service_account", serviceAccountId: account.id }, permission: "read" });
      if (!duplicate.ok) throw new Error("Duplicate fixture failed");
      await sql`INSERT INTO assistant.artifact_access(artifact_id,access_id) SELECT id,${duplicate.data.id}::uuid FROM assistant.artifacts WHERE short_id=${app.id}`;
      expect((await call(token.data.token, app.id, "execute", request())).status).toBe(403);
      await deleteAccess({ id: duplicate.data.id });
      expect(
        (await call(readToken.data.token, app.id, "storage", { area: "kv", operation: "write", key: "denied", content: "1" })).status,
      ).toBe(403);
      expect((await call(token.data.token, other.id, "source")).status).toBe(403);
      expect((await call(token.data.token, other.id, "execute", request())).status).toBe(403);
      await sql`UPDATE auth.service_accounts SET kind='resource_bound',app_id='assistant',resource_type='artifact',resource_id=${other.id} WHERE id=${account.id}::uuid`;
      expect((await call(token.data.token, app.id, "source")).status).toBe(403);
      await expect(
        artifacts.grant(other.id, { type: "service_account", serviceAccountId: account.id }, "read", owner),
      ).resolves.toBeDefined();
      await expect(artifacts.grant(app.id, { type: "service_account", serviceAccountId: account.id }, "read", owner)).rejects.toMatchObject(
        { code: "INVALID_INPUT" },
      );
      await sql`UPDATE auth.service_accounts SET kind=${kind},app_id=NULL,resource_type=NULL,resource_id=NULL WHERE id=${account.id}::uuid`;
      const execution = request();
      const response = await call(token.data.token, app.id, "execute", execution);
      expect(await response.clone().json()).toMatchObject({
        requestId: execution.requestId,
        result: { status: "completed", output: { value: 42, file: "machine output", user: null } },
      });
      expect(response.status).toBe(200);
      const action = await call(token.data.token, app.id, "execute", { ...request(), action: "double", input: { value: 21 } });
      expect(action.status).toBe(200);
      expect(await action.json()).toMatchObject({ result: { output: { doubled: 42 } } });
      expect((await call(token.data.token, app.id, "execute", { ...request(), action: "double", input: { value: "bad" } })).status).toBe(
        400,
      );
      expect((await call(token.data.token, app.id, "execute", execution)).status).toBe(409);
      expect((await call(token.data.token, app.id, `runs/${execution.requestId}`)).status).toBe(200);
      const authenticated = await serviceAccountCredentials.authenticateApiToken(token.data.token);
      if (!authenticated) throw new Error("Token not authenticated");
      const identity: ArtifactIdentity = {
        actor: {
          kind: "service_account",
          serviceAccount: authenticated.serviceAccount,
          delegatedUser: null,
          credentialId: authenticated.credential.id,
          scopes: authenticated.credential.scopes,
        },
        accessSubject: { type: "service_account", serviceAccountId: account.id },
      };
      await expect(
        artifacts.storage(app.id, { scope: "user", area: "kv", operation: "read", key: "private" }, identity),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      await expect(artifacts.get(app.id, { ...identity, accessSubject: owner.accessSubject })).rejects.toMatchObject({
        code: "ACCESS_DENIED",
      });
      expect((await call(token.data.token, app.id, "execute", { ...request(), publishedVersion: 2 })).status).toBe(409);
      await expect(artifactDatabase.runtime(app.id, { operation: "query", sql: "SELECT 1", params: [] }, identity)).rejects.toMatchObject({
        code: "ACCESS_DENIED",
      });
      const secret = await machineAccess.saveSecret(
        app.id,
        {
          name: "api",
          origin: "https://api.example.com",
          header: "authorization",
          prefix: "Bearer ",
          value: "fixture-secret",
          expectedRevision: null,
        },
        owner,
      );
      let policy = await machineAccess.save(
        app.id,
        grant.id,
        {
          rights: MachineRights.parse({
            execute: true,
            storage: "write",
            database: "write",
            secrets: ["api"],
            http: [{ origin: "https://api.example.com", methods: ["GET"] }],
          }),
          expectedRevision: rights.revision,
        },
        owner,
      );
      let sent = 0;
      const send = async (input: Parameters<NonNullable<Parameters<typeof machineHttp>[5]>>[0]) => {
        sent++;
        expect(input.headers).toMatchObject({ authorization: "Bearer fixture-secret" });
        return { status: 200, headers: {}, body: new TextEncoder().encode("Bearer fixture-secret") };
      };
      const http = { url: "https://api.example.com/report", headers: { authorization: { secret: "api", prefix: "Bearer " } } };
      const received = await machineHttp(app.id, 1, http, identity, new AbortController().signal, send);
      expect(Buffer.from(received.body, "base64").toString()).not.toContain("fixture-secret");
      await expect(
        machineHttp(app.id, 1, { ...http, url: "https://other.example.com/report" }, identity, new AbortController().signal, send),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      await expect(machineHttp(app.id, 1, { ...http, method: "POST" }, identity, new AbortController().signal, send)).rejects.toMatchObject(
        { code: "ACCESS_DENIED" },
      );
      await machineAccess.removeSecret(app.id, "api", secret.revision, owner);
      await expect(machineHttp(app.id, 1, http, identity, new AbortController().signal, send)).rejects.toMatchObject({
        code: "ACCESS_DENIED",
      });
      expect(sent).toBe(1);
      if (testInfra.rsql) {
        const settings = spyOn(assistantApp.settings, "get").mockImplementation(
          async (key) =>
            ({
              "assistant.storage_total_mib": 250,
              "assistant.storage_file_mib": 50,
              "assistant.rsql_url": testInfra.rsql!,
              "assistant.rsql_api_token": "artifact-test-only",
            })[key],
        );
        try {
          await artifactDatabase.connect(app.id, owner);
          await artifactDatabase.call(
            app.id,
            { operation: "tables.create", name: "records", columns: [{ name: "value", type: "text" }], write: "own" },
            owner,
            undefined,
            "maintenance",
          );
          const inserted = await artifactDatabase.runtime(
            app.id,
            { operation: "insert", table: "records", rows: { value: "machine" } },
            identity,
          );
          expect(inserted).toMatchObject({ value: "machine", created_by: `service_account:${account.id}` });
          policy = await machineAccess.save(
            app.id,
            grant.id,
            { rights: MachineRights.parse({ execute: true, database: "read" }), expectedRevision: policy.revision },
            owner,
          );
          expect(
            await artifactDatabase.runtime(app.id, { operation: "query", sql: "SELECT value FROM records", params: [] }, identity),
          ).toEqual([{ value: "machine" }]);
          await expect(
            artifactDatabase.runtime(app.id, { operation: "insert", table: "records", rows: { value: "denied" } }, identity),
          ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
        } finally {
          settings.mockRestore();
        }
      }
      policy = await machineAccess.save(app.id, grant.id, { rights: MachineRights.parse({}), expectedRevision: policy.revision }, owner);
      expect((await call(token.data.token, app.id, "execute", request())).status).toBe(403);
      // Cached identity also loses data rights without reauthenticating.
      await expect(
        artifacts.storage(app.id, { area: "kv", operation: "write", key: "revoked", content: "true" }, identity),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      // Management scope and sharing authority are independently required.
      await artifacts.changeGrant(app.id, grant.id, "admin", owner);
      const managerToken = await serviceAccountCredentials.createApiToken({
        serviceAccountId: account.id,
        name: "Studio management",
        scopes: ["admin"],
      });
      if (!managerToken.ok) throw new Error("Manager token fixture failed");
      const share = { principal: { type: "user", userId: "00000000-0000-4000-8000-000000000002" }, permission: "read" };
      expect((await call(managerToken.data.token, app.id, "grants", share)).status).toBe(403);
      policy = await machineAccess.save(
        app.id,
        grant.id,
        { rights: MachineRights.parse({ sharing: true }), expectedRevision: policy.revision },
        owner,
      );
      expect((await call(token.data.token, app.id, "grants", share)).status).toBe(403);
      expect((await call(managerToken.data.token, app.id, "grants", share)).status).toBe(200);
      await artifacts.changeGrant(app.id, grant.id, null, owner);
      expect((await call(token.data.token, app.id, "source")).status).toBe(403);
      await expect(artifacts.get(app.id, identity)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      const replacement = await artifacts.grant(app.id, { type: "service_account", serviceAccountId: account.id }, "read", owner);
      await machineAccess.save(app.id, replacement!.id, { rights: MachineRights.parse({ execute: true }), expectedRevision: null }, owner);
      await sql`UPDATE auth.service_accounts SET status='disabled' WHERE id=${account.id}::uuid`;
      expect((await call(token.data.token, app.id, "execute", request())).status).toBe(401);
      await expect(artifacts.get(app.id, identity)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      await sql`UPDATE auth.service_accounts SET status='active' WHERE id=${account.id}::uuid`;
      await serviceAccountCredentials.revoke({
        credentialId: authenticated.credential.id,
        system: { service: "studio-integration", reason: "test revocation" },
      });
      expect((await call(token.data.token, app.id, "source")).status).toBe(401);
      await expect(artifacts.get(app.id, identity)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      const [audit] =
        await sql`SELECT principal_id,credential_id,version,status FROM assistant.artifact_machine_runs WHERE id=${execution.requestId}::uuid`;
      expect(audit).toMatchObject({
        principal_id: account.id,
        credential_id: authenticated.credential.id,
        version: 1,
        status: "completed",
      });
      const trail =
        await sql`SELECT metadata FROM audit.events WHERE action LIKE 'studio.machine.%' AND metadata->>'serviceAccountId'=${account.id}`;
      expect(trail.length).toBeGreaterThan(3);
      const serializedTrail = JSON.stringify(trail);
      expect(serializedTrail).not.toContain(token.data.token);
      expect(serializedTrail).not.toContain("fixture-secret");
      expect(serializedTrail).not.toContain("machine output");
      await artifacts.remove(app.id, owner);
      await artifacts.remove(other.id, owner);
      await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id=${account.id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id=${account.id}::uuid`;
    },
    120000,
  );

  for (const operation of ["http", "database"] as const) {
    test.each(["agent", "standalone"] as const)(
      `%s runtime: individual request cancellation stops queued ${operation} effects with live execution`,
      async (kind) => {
        const created = await serviceAccounts.createStandalone({ name: "Request cancellation fixture", kind });
        if (!created.ok) throw new Error("Account fixture failed");
        const account = created.data;
        const issued = await serviceAccountCredentials.createApiToken({ serviceAccountId: account.id, name: "Runtime", scopes: ["write"] });
        if (!issued.ok) throw new Error("Credential fixture failed");
        const authenticated = await serviceAccountCredentials.authenticateApiToken(issued.data.token);
        if (!authenticated) throw new Error("Authentication failed");
        const identity: ArtifactIdentity = {
          actor: {
            kind: "service_account",
            serviceAccount: authenticated.serviceAccount,
            delegatedUser: null,
            credentialId: authenticated.credential.id,
            scopes: authenticated.credential.scopes,
          },
          accessSubject: { type: "service_account", serviceAccountId: account.id },
          machineExecution: { version: 1 },
        };
        const settings = spyOn(assistantApp.settings, "get").mockImplementation(
          async (key) =>
            ({
              "assistant.storage_total_mib": 250,
              "assistant.storage_file_mib": 50,
              "assistant.rsql_url": testInfra.rsql!,
              "assistant.rsql_api_token": "artifact-test-only",
            })[key],
        );
        const app = await artifacts.create({ title: "Request cancellation", source }, owner);
        try {
          await artifacts.publish(app.id, app.revision, owner, "Request cancellation publication");
          const grant = await artifacts.grant(app.id, { type: "service_account", serviceAccountId: account.id }, "read", owner);
          await machineAccess.save(
            app.id,
            grant!.id,
            {
              rights: MachineRights.parse({
                execute: true,
                database: "write",
                http: [{ origin: "https://example.com", methods: ["POST"] }],
              }),
              expectedRevision: null,
            },
            owner,
          );
          await artifactDatabase.connect(app.id, owner);
          await artifactDatabase.call(
            app.id,
            {
              operation: "tables.create",
              name: "records",
              columns: [{ name: "value", type: "text" }],
              write: "own",
            },
            owner,
            undefined,
            "maintenance",
          );
          const execution = new AbortController();
          const host = createMachineHostRoutes({
            id: app.id,
            input: { ...request(), artifactId: app.id },
            identity,
            locale: "en",
            timeZone: "UTC",
            signal: execution.signal,
          });
          const originalHttp = machineHttp;
          const originalDatabase = artifactDatabase.runtime.bind(artifactDatabase);
          const cancel = new AbortController();
          const queued = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          let lock: Promise<unknown> | undefined;
          // The service is entered only after real runtime middleware authorization.
          // Hold its real artifact row lock until PostgreSQL observes the effect waiting.
          const blockedEffect = async <T>(run: () => Promise<T>) => {
            const acquired = Promise.withResolvers<number>();
            lock = sql.begin(async (db) => {
              const [backend] = await db<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
              await db`SELECT id FROM assistant.artifacts WHERE short_id=${app.id} FOR UPDATE`;
              acquired.resolve(backend!.pid);
              await release.promise;
            });
            void lock.catch((error) => {
              acquired.reject(error);
              queued.reject(error);
            });
            const pid = await acquired.promise;
            const effect = run();
            void effect.catch(() => {});
            try {
              const until = performance.now() + 3000;
              for (;;) {
                const [blocked] = await sql<{ waiting: boolean }[]>`SELECT EXISTS(
                  SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
                ) AS waiting`;
                if (blocked!.waiting) break;
                if (performance.now() >= until) throw new Error("Runtime effect did not reach the lock barrier");
                await Bun.sleep(5);
              }
              queued.resolve();
            } catch (error) {
              queued.reject(error);
              release.resolve();
            }
            return effect;
          };
          let sends = 0;
          const send: NonNullable<Parameters<typeof machineHttp>[5]> = async () => {
            sends++;
            return { status: 200, headers: {}, body: new Uint8Array() };
          };
          const http =
            operation === "http"
              ? spyOn(machineService, "machineHttp").mockImplementation((id, version, input, actor, signal) =>
                  blockedEffect(() => originalHttp(id, version, input, actor, signal, send)),
                )
              : undefined;
          const database =
            operation === "database"
              ? spyOn(artifactDatabase, "runtime").mockImplementation((...args) => blockedEffect(() => originalDatabase(...args)))
              : undefined;
          const snapshot = () => sql`SELECT data_revision FROM assistant.artifact_databases
            WHERE artifact_id=(SELECT id FROM assistant.artifacts WHERE short_id=${app.id})`;
          const before = await snapshot();
          const body =
            operation === "http"
              ? { url: "https://example.com/report", method: "POST", headers: {}, body: "eA==" }
              : { operation: "insert", table: "records", rows: { value: "cancelled" } };
          const invoke = (signal?: AbortSignal) =>
            host.request(`/api/assistant/artifacts/runtime/machine/${operation}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
              signal,
            });
          let response: Promise<Response> | undefined;
          try {
            response = Promise.resolve(invoke(cancel.signal));
            await Promise.race([
              queued.promise,
              response.then(() => {
                throw new Error("Effect finished before the lock barrier");
              }),
            ]);
            expect(execution.signal.aborted).toBe(false);
            cancel.abort();
            release.resolve();
            expect((await response).ok).toBe(false);
          } finally {
            release.resolve();
            try {
              if (response) await response;
              await lock;
            } finally {
              http?.mockRestore();
              database?.mockRestore();
            }
          }
          expect(execution.signal.aborted).toBe(false);
          expect(sends).toBe(0);
          expect(await snapshot()).toEqual(before);
          expect(await originalDatabase(app.id, { operation: "query", sql: "SELECT value FROM records", params: [] }, identity)).toEqual(
            [],
          );
          // A fresh request through the same host proves execution and grants stay active.
          const liveHttp =
            operation === "http"
              ? spyOn(machineService, "machineHttp").mockImplementation((id, version, input, actor, signal) =>
                  originalHttp(id, version, input, actor, signal, send),
                )
              : undefined;
          try {
            expect((await invoke()).ok).toBe(true);
          } finally {
            liveHttp?.mockRestore();
          }
          if (operation === "http") expect(sends).toBe(1);
          else
            expect(await originalDatabase(app.id, { operation: "query", sql: "SELECT value FROM records", params: [] }, identity)).toEqual([
              { value: "cancelled" },
            ]);
        } finally {
          await artifacts.remove(app.id, owner);
          settings.mockRestore();
          await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id=${account.id}::uuid`;
          await sql`DELETE FROM auth.service_accounts WHERE id=${account.id}::uuid`;
        }
      },
    );
  }

  for (const surface of ["direct", "runtime"] as const) {
    for (const reason of ["AbortError", "TimeoutError"] as const) {
      test.each(["agent", "standalone"] as const)(
        `%s ${surface}: queued JSON/binary writes and deletes roll back on ${reason} with live grants`,
        async (kind) => {
          const created = await serviceAccounts.createStandalone({ name: "Storage barrier fixture", kind });
          if (!created.ok) throw new Error("Account fixture failed");
          const account = created.data;
          const issued = await serviceAccountCredentials.createApiToken({
            serviceAccountId: account.id,
            name: "Storage barrier",
            scopes: ["write"],
          });
          if (!issued.ok) throw new Error("Credential fixture failed");
          const authenticated = await serviceAccountCredentials.authenticateApiToken(issued.data.token);
          if (!authenticated) throw new Error("Authentication failed");
          const identity: ArtifactIdentity = {
            actor: {
              kind: "service_account",
              serviceAccount: authenticated.serviceAccount,
              delegatedUser: null,
              credentialId: authenticated.credential.id,
              scopes: authenticated.credential.scopes,
            },
            accessSubject: { type: "service_account", serviceAccountId: account.id },
            machineExecution: { version: 1 },
          };
          const app = await artifacts.create({ title: "Storage barrier", source }, owner);
          try {
            await artifacts.publish(app.id, app.revision, owner, "Barrier publication");
            const grant = await artifacts.grant(app.id, { type: "service_account", serviceAccountId: account.id }, "read", owner);
            await machineAccess.save(
              app.id,
              grant!.id,
              { rights: MachineRights.parse({ execute: true, storage: "write" }), expectedRevision: null },
              owner,
            );
            await artifacts.storage(app.id, { area: "kv", operation: "write", key: "json", content: "1" }, owner);
            await artifacts.storage(app.id, { area: "files", operation: "write", key: "binary" }, owner, false, new Uint8Array([1]));
            const snapshot = () => sql`SELECT area,key,content,data,bytes,version,updated_at FROM assistant.artifact_storage
              WHERE artifact_id=(SELECT id FROM assistant.artifacts WHERE short_id=${app.id}) ORDER BY area,key`;
            const original = artifacts.storage.bind(artifacts);
            for (const area of ["kv", "files"] as const) {
              for (const operation of ["write", "delete"] as const) {
                const before = await snapshot();
                const state = await artifacts.storageState(app.id, owner);
                const cancel = new AbortController();
                const acquired = Promise.withResolvers<number>();
                const queued = Promise.withResolvers<void>();
                const release = Promise.withResolvers<void>();
                let lock: Promise<unknown> | undefined;
                const storage = spyOn(artifacts, "storage").mockImplementation(async (...args) => {
                  // Enter after route authorization and binary body-limit lookup.
                  // The actual owning service must wait, with all grants still live.
                  lock = sql.begin(async (db) => {
                    const [backend] = await db<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
                    await db`SELECT id FROM assistant.artifacts WHERE short_id=${app.id} FOR UPDATE`;
                    acquired.resolve(backend!.pid);
                    await release.promise;
                  });
                  void lock.catch((error) => {
                    acquired.reject(error);
                    queued.reject(error);
                  });
                  const pid = await acquired.promise;
                  const mutation = original(...args);
                  void mutation.catch(() => {});
                  try {
                    // Observe a real resource-lock wait; no timing-only barrier.
                    const until = performance.now() + 3000;
                    for (;;) {
                      const [blocked] = await sql<{ waiting: boolean }[]>`SELECT EXISTS(
                        SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
                      ) AS waiting`;
                      if (blocked!.waiting) break;
                      if (performance.now() >= until) throw new Error("Storage did not reach the lock barrier");
                      await Bun.sleep(5);
                    }
                    queued.resolve();
                  } catch (error) {
                    queued.reject(error);
                    release.resolve();
                  }
                  return mutation;
                });
                let effect: Promise<Response> | undefined;
                try {
                  const key = area === "kv" ? "json" : "binary";
                  const binary = area === "files" && operation === "write";
                  const path = `storage${binary ? `/file?key=${key}` : ""}`;
                  const init = {
                    method: binary ? "PUT" : "POST",
                    headers: {
                      authorization: `Bearer ${issued.data.token}`,
                      "content-type": binary ? "application/octet-stream" : "application/json",
                    },
                    body: binary
                      ? new Uint8Array([2])
                      : JSON.stringify({ area, operation, key, ...(operation === "write" ? { content: "2" } : {}) }),
                    signal: surface === "direct" ? cancel.signal : new AbortController().signal,
                  };
                  effect = Promise.resolve(
                    surface === "direct"
                      ? router.request(`/${app.id}/${path}`, init)
                      : createMachineHostRoutes({
                          id: app.id,
                          input: { ...request(), artifactId: app.id },
                          identity,
                          locale: "en",
                          timeZone: "UTC",
                          signal: cancel.signal,
                        }).request(`/api/assistant/artifacts/runtime/machine/${path}`, init),
                  );
                  await Promise.race([
                    queued.promise,
                    effect.then(() => {
                      throw new Error("Effect finished before the lock barrier");
                    }),
                  ]);
                  // Both cancellation kinds use the standard AbortSignal reason,
                  // delivered deterministically after observing the lock wait.
                  cancel.abort(new DOMException("Storage fixture cancelled", reason));
                  release.resolve();
                  const response = await effect;
                  expect(response.ok).toBe(false);
                  expect(await response.json()).toMatchObject({ code: "EXECUTION_FAILED" });
                } finally {
                  release.resolve();
                  try {
                    if (effect) await effect;
                    await lock;
                  } finally {
                    storage.mockRestore();
                  }
                }
                expect(await snapshot()).toEqual(before);
                expect((await artifacts.storageState(app.id, owner)).storageRevision).toBe(state.storageRevision);
                // No revocation caused the rejection: a fresh write still succeeds.
                expect(
                  (
                    await call(issued.data.token, app.id, "storage", {
                      area: "kv",
                      operation: "write",
                      key: "live-grant",
                      content: "1",
                    })
                  ).status,
                ).toBe(200);
              }
            }
          } finally {
            await artifacts.remove(app.id, owner);
            await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id=${account.id}::uuid`;
            await sql`DELETE FROM auth.service_accounts WHERE id=${account.id}::uuid`;
          }
        },
      );
    }
  }

  test.each(["agent", "standalone"] as const)(
    "%s token: queued effects and active execution stop after rights revocation or disable",
    async (kind) => {
      const created = await serviceAccounts.createStandalone({ name: `Studio cancellation ${kind}`, kind });
      if (!created.ok) throw new Error("Account creation failed");
      const account = created.data;
      const issued = await serviceAccountCredentials.createApiToken({
        serviceAccountId: account.id,
        name: "Cancellation",
        scopes: ["write"],
      });
      if (!issued.ok) throw new Error("Token creation failed");
      const authenticated = await serviceAccountCredentials.authenticateApiToken(issued.data.token);
      if (!authenticated) throw new Error("Authentication failed");
      const identity: ArtifactIdentity = {
        actor: {
          kind: "service_account",
          serviceAccount: authenticated.serviceAccount,
          delegatedUser: null,
          credentialId: authenticated.credential.id,
          scopes: authenticated.credential.scopes,
        },
        accessSubject: { type: "service_account", serviceAccountId: account.id },
      };
      const app = await artifacts.create({ title: "Cancellation fixture", source }, owner);
      await artifacts.publish(app.id, app.revision, owner, "Cancellation publication");
      const grant = await artifacts.grant(app.id, { type: "service_account", serviceAccountId: account.id }, "read", owner);
      let policy = await machineAccess.save(
        app.id,
        grant!.id,
        { rights: MachineRights.parse({ execute: true, storage: "write" }), expectedRevision: null },
        owner,
      );
      const options = { signal: new AbortController().signal, locale: "en", timeZone: "UTC" };
      let closed = 0,
        reachedEffect = false;
      const queued = request();
      await expect(
        executeMachine(app.id, queued, identity, options, async () => {
          // The job waited for host startup. Disable before it can enter the sandbox.
          await sql`UPDATE auth.service_accounts SET status='disabled' WHERE id=${account.id}::uuid`;
          return {
            close: async () => {
              closed++;
            },
            machine: async () => {
              reachedEffect = true;
              return null;
            },
          };
        }),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      expect(reachedEffect).toBe(false);
      expect(closed).toBe(1);
      await sql`UPDATE auth.service_accounts SET status='active' WHERE id=${account.id}::uuid`;
      await expect(
        executeMachine(app.id, request(), identity, options, async () => {
          throw new CodeHostBusyError();
        }),
      ).rejects.toMatchObject({ code: "EXECUTION_BUSY" });
      const cancel = new AbortController();
      await expect(
        executeMachine(app.id, request(), identity, { ...options, signal: cancel.signal }, async () => {
          cancel.abort();
          return {
            close: async () => {
              closed++;
            },
            machine: async () => {
              reachedEffect = true;
              return null;
            },
          };
        }),
      ).rejects.toMatchObject({ code: "EXECUTION_CANCELLED" });
      expect(reachedEffect).toBe(false);
      const started = Promise.withResolvers<void>();
      const activeRequest = request();
      const running = executeMachine(app.id, activeRequest, identity, options, async (context) => ({
        close: async () => {
          closed++;
        },
        machine: async (_input, signal) => {
          started.resolve();
          await machineAccess.save(app.id, grant!.id, { rights: MachineRights.parse({}), expectedRevision: policy.revision }, owner);
          // Even an already queued host request cannot use its old authority.
          const effect = await context.fetch(`/api/assistant/artifacts/runtime/machine/storage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ area: "kv", operation: "write", key: "must-not-exist", content: "1" }),
          });
          expect(effect.status).toBe(403);
          await new Promise((_resolve, reject) => {
            if (signal?.aborted) reject(signal.reason);
            else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      }));
      await started.promise;
      await expect(running).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      expect(closed).toBeGreaterThanOrEqual(2);
      expect(activeMachineHosts()).toBe(0);
      const [run] = await sql`SELECT status,error_code FROM assistant.artifact_machine_runs WHERE id=${activeRequest.requestId}::uuid`;
      expect(run).toMatchObject({ status: "failed", error_code: "ACCESS_DENIED" });
      const storage = await artifacts.storage(app.id, { area: "kv", operation: "read", key: "must-not-exist" }, owner);
      expect(storage).toMatchObject({ item: null });
      await artifacts.remove(app.id, owner);
      await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id=${account.id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id=${account.id}::uuid`;
    },
    15000,
  );
}
