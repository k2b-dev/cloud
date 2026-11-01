import { expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import {
  ContactDirectoryResolveDataSchema,
  ContactDirectoryResolveInputSchema,
  ContactDirectorySuggestDataSchema,
  ContactDirectorySuggestInputSchema,
  defineCapabilities,
} from "@k2b/cloud/contracts";
import type { AuthContext, RequestAuthority } from "@k2b/cloud/server";
import { invalidateSettingsCache, read } from "@k2b/cloud/services/settings";
import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import { compileCapabilities, invokeCompiledCapability } from "../../cloud/src/_internal/capabilities";
import * as registry from "../../cloud/src/_internal/registry";
import { createCapabilityRoutes } from "../../cloud/src/api/capabilities";
import { createSettingsOpsRoutes } from "../../cloud/src/api/settings-ops";
import { resolveInvocationAuthority } from "../../cloud/src/services/identity/invocation-actor";
import { capabilityInvocationOperation } from "../../cloud/src/services/identity/invocation-operations";
import { verifyInvocationToken } from "../../cloud/src/services/identity/invocation-token";
import contactDirectoryRoutes from "../src/api/contact-directory";
import { MAIL_CONTACT_DIRECTORY_DEFAULTS, MAIL_CONTACT_DIRECTORY_SETTING_KEYS } from "../src/contact-directory-settings";
import { resolveContacts as resolveBrowserContacts, suggestContacts } from "../src/frontend/_components/contact-capabilities";
import { resolveContacts } from "../src/service/app-integrations";
import { loadContactDirectoryAdmin, resolveRegisteredContactDirectory, saveContactDirectory } from "../src/service/contact-directory";
import { createRecipientMailboxFixture } from "./fixtures/recipient-suggestions";

suiteFor(
  "database",
  "nats",
  "valkey",
)("Mail configured contact directory", () => {
  test("a sender uses suggest and resolve through Core after the administrator configures an app with access", async () => {
    const administrator = await createRecipientMailboxFixture();
    const sender = await createRecipientMailboxFixture();
    const originalFetch = globalThis.fetch;
    const spies: Array<{ mockRestore(): void }> = [];
    try {
      await sql`UPDATE auth.users SET admin = true WHERE id = ${administrator.user.id}::uuid`;
      const admin: RequestAuthority = {
        ...administrator.context,
        actor: { kind: "user", user: { ...administrator.user, roles: ["admin", "user"] } },
        credentialKind: "session",
        scopes: [],
      };
      const senderAuthority: RequestAuthority = { ...sender.context, credentialKind: "oauth", scopes: ["read", "write"] };
      let providerCalls = 0;
      const contact = {
        contactId: "customer-1",
        bookId: "customers",
        displayName: "Ada Example",
        companyName: null,
        jobTitle: null,
        emails: [{ label: null, email: "ada@example.test" }],
        phones: [],
        contactPointsTruncated: false,
        updatedAt: "2026-10-01T12:00:00.000Z",
      };
      const assertSender = (authority: Pick<RequestAuthority, "actor" | "accessSubject">) => {
        expect(authority.actor.kind).toBe("user");
        if (authority.actor.kind !== "user") throw new Error("Expected the sender as a user");
        expect(authority.actor.user.id).toBe(sender.user.id);
        expect(authority.actor.user.roles).toContain("user");
        expect(authority.actor.user.roles).not.toContain("admin");
        expect(authority.accessSubject).toEqual(senderAuthority.accessSubject);
        providerCalls++;
      };
      const compiled = compileCapabilities(
        "directory-fixture",
        defineCapabilities({
          protocolVersion: 2,
          queries: {
            "contact.suggest": {
              title: "Suggest contacts",
              description: "Suggest readable contacts.",
              input: ContactDirectorySuggestInputSchema,
              data: ContactDirectorySuggestDataSchema,
              openWorld: false,
              run: async (_input, context) => {
                assertSender(context);
                return { ok: true, data: { data: [contact] } };
              },
            },
            "contact.resolve": {
              title: "Resolve contacts",
              description: "Resolve readable contacts.",
              input: ContactDirectoryResolveInputSchema,
              data: ContactDirectoryResolveDataSchema,
              openWorld: false,
              run: async (_input, context) => {
                assertSender(context);
                return {
                  ok: true,
                  data: {
                    data: {
                      items: [
                        {
                          ...contact,
                          ref: { type: "directory-fixture.contact", id: contact.contactId },
                          bookName: "Customers",
                          matchedEmails: ["ada@example.test"],
                        },
                      ],
                      matchedEmails: ["ada@example.test"],
                    },
                  },
                };
              },
            },
          },
        }),
      );
      const providerRoles: Array<"admin" | "user"> = ["user"];
      const app = {
        id: "directory-fixture",
        name: "Directory",
        description: "Contact fixture",
        icon: "ti ti-users",
        baseUrl: "http://directory.test",
        routes: [],
        access: { kind: "roles" as const, roles: providerRoles },
        capabilities: { protocolVersion: 2 as const, manifestHash: compiled.manifest.manifestHash },
      };
      const capability = {
        appId: app.id,
        appName: app.name,
        appIcon: app.icon,
        appDescription: app.description,
        endpoint: "http://directory.test/internal/capabilities",
        manifest: compiled.manifest,
      };
      spies.push(
        spyOn(registry, "getApp").mockImplementation(async (id) => (id === app.id ? app : null)),
        spyOn(registry, "listApps").mockResolvedValue([app]),
        spyOn(registry, "getCapability").mockImplementation(async (id) => (id === app.id ? capability : null)),
      );
      const config = { ...MAIL_CONTACT_DIRECTORY_DEFAULTS, appId: app.id, read: "", create: "", listWritableBooks: "" };
      expect(await saveContactDirectory({ ...admin, authority: admin }, config, "en")).toEqual({ ok: true, config });
      expect((await read("mail.contact_directory.app")).value).toBe(app.id);
      const view = await loadContactDirectoryAdmin({ ...admin, authority: admin }, config, "en");
      expect(view).toMatchObject({
        ok: true,
        data: { apps: [{ appId: app.id }], issues: [] },
      });
      const settingsApi = new Hono<AuthContext>()
        .use("*", async (c, next) => {
          c.set("actor", admin.actor);
          c.set("accessSubject", admin.accessSubject);
          c.set("credentialKind", admin.credentialKind);
          c.set("credentialScopes", admin.scopes);
          c.set("user", { ...administrator.user, roles: ["admin", "user"] });
          return next();
        })
        .route("/mail", contactDirectoryRoutes)
        .route("/generic", createSettingsOpsRoutes(Object.values(MAIL_CONTACT_DIRECTORY_SETTING_KEYS)));
      const writeSetting = (path: string, value: string) =>
        settingsApi.request(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });
      expect((await writeSetting("/mail/admin/settings/mail.contact_directory.app", app.id)).status).toBe(200);
      expect((await writeSetting("/mail/admin/settings/mail.contact_directory.app", "unavailable-app")).status).toBe(400);
      expect((await writeSetting("/generic/mail.contact_directory.app", app.id)).status).toBe(400);
      expect((await read("mail.contact_directory.app")).value).toBe(app.id);
      if (!view.ok) throw new Error(view.error.message);
      const directory = await resolveRegisteredContactDirectory(view.data.config);
      const pair = await generateKeyPair("RS256", { extractable: true });
      const signer = {
        kid: "33333333-3333-4333-8333-333333333333",
        key: pair.privateKey,
        signUntil: new Date("2099-01-01T00:00:00Z"),
        issuer: "https://core.test",
      };
      const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: signer.kid, alg: "RS256", use: "sig" }] });
      const core = new Hono().route(
        "/api",
        createCapabilityRoutes({
          authenticate: async (c, next) => {
            expect(c.req.header("authorization")).toBe("Bearer sender-fixture");
            c.set("actor", senderAuthority.actor);
            c.set("accessSubject", senderAuthority.accessSubject);
            c.set("user", sender.user);
            c.set("credentialKind", senderAuthority.credentialKind);
            c.set("credentialScopes", senderAuthority.scopes);
            c.set("oauthScopes", senderAuthority.scopes);
            return next();
          },
          withActiveSigner: async (_purpose, callback) => callback(signer, sql),
          fetch: async (input, init) => {
            const request = new Request(input, init);
            const localId = new URL(request.url).pathname.split("/").at(-1)!;
            const operation = compiled.manifest.queries.find((query) => query.localId === localId)!;
            const claims = await verifyInvocationToken(
              request.headers.get("authorization")!.slice(7),
              { targetAppId: app.id, operation: capabilityInvocationOperation("queries", localId), schemaHash: operation.schemaHash },
              { issuer: signer.issuer, key: jwks },
            );
            if (!claims) throw new Error("Provider rejected the signed invocation");
            expect(claims.sub).toBe(sender.user.id);
            expect(claims.access_subject_id).toBe(sender.user.id);
            expect(claims.scopes).toEqual(["read", "write"]);
            const authority = await resolveInvocationAuthority(claims, sql, []);
            if (!authority) throw new Error("Provider could not resolve the signed sender");
            const body = await request.json();
            const result = await invokeCompiledCapability({
              compiled,
              kind: "query",
              localId,
              input: body.input,
              expectedSchemaHash: operation.schemaHash,
              onUnexpectedError: (error) => console.error(error),
              context: {
                authority,
                actor: authority.actor,
                accessSubject: authority.accessSubject,
                user: authority.actor.kind === "user" ? authority.actor.user : authority.actor.delegatedUser,
                locale: "en",
                requestId: "directory-runtime",
                origin: "app",
                signal: request.signal,
              },
            });
            return Response.json(result.ok ? result.data : result.error, { status: result.ok ? 200 : result.error.status });
          },
        }),
      );
      const transport = async (input: RequestInfo | URL, init?: RequestInit) =>
        core.request(
          new Request(
            new URL(String(input instanceof Request ? input.url : input), "https://core.test"),
            input instanceof Request ? input : init,
          ),
        );
      // Browser calls carry the current sender's credential to Core, just as the browser session does.
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) =>
          transport(input, {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: "Bearer sender-fixture" },
          }),
        { preconnect: originalFetch.preconnect },
      );
      expect((await suggestContacts(directory.suggest, { query: "ada" })).data).toEqual([contact]);
      expect((await resolveBrowserContacts(directory.resolve, { emails: ["ada@example.test"] })).data.items[0]?.contactId).toBe(
        contact.contactId,
      );
      expect(
        await resolveContacts({ emails: ["ada@example.test"] }, { authorization: "Bearer sender-fixture" }, directory.resolve),
      ).toMatchObject({ ok: true, data: { items: [{ contactId: contact.contactId }] } });
      expect(providerCalls).toBe(3);
      // The same sender retains global read/write, but loses app use before another call.
      app.access.roles = ["admin"];
      const denied = await transport(`/api/capabilities/v1/queries/${app.id}/contact.suggest`, {
        method: "POST",
        headers: { authorization: "Bearer sender-fixture", "content-type": "application/json" },
        body: JSON.stringify({ input: { query: "ada" } }),
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "app_access_denied" });
      expect(providerCalls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
      for (const spy of spies) spy.mockRestore();
      const keys = Object.values(MAIL_CONTACT_DIRECTORY_SETTING_KEYS);
      await sql`DELETE FROM settings.entries WHERE key IN ${sql(keys)}`;
      await invalidateSettingsCache(keys);
      await sender.cleanup();
      await administrator.cleanup();
    }
  });
});
