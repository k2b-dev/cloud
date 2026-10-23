import { expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import type { AppRegistryEntry } from "../../contracts/registry";
import { HELP_KINDS } from "../../shared/help";
import { buildProjectedUser } from "../session/user";
import { createHelpReader } from "./index";
import * as store from "./store";

test("manifests preserve each localized row's article kind", async () => {
  // Only the corpus-existence query runs locally; article selection is stubbed at the store boundary.
  const db = new SQL("sqlite://:memory:");
  const app: AppRegistryEntry = {
    id: "inventory",
    name: "Inventory",
    description: "Inventory",
    icon: "ti ti-package",
    routes: [],
    baseUrl: "http://inventory",
    help: { manifestHash: "fixture", baseLocale: "en", pageBase: "/help/apps/inventory" },
  };
  const rows = HELP_KINDS.map((kind, index) => ({
    app_id: app.id,
    app_name: app.name,
    manifest_hash: "fixture",
    locale: "de",
    document_id: kind,
    title: kind,
    description: null,
    icon: null,
    sort_order: index,
    kind,
    needs: null,
    next_id: null,
    related: [],
  }));
  const query = spyOn(store, "queryHelp").mockResolvedValue(rows);
  try {
    await db`ATTACH DATABASE ':memory:' AS help`;
    await db`CREATE TABLE help.corpora (app_id TEXT, manifest_hash TEXT)`;
    await db`INSERT INTO help.corpora VALUES (${app.id}, ${"fixture"})`;
    const reader = createHelpReader(
      "de",
      {
        kind: "user",
        user: buildProjectedUser({
          id: "11111111-1111-4111-8111-111111111111",
          provider: "local",
          profile: "user",
          effective_admin: false,
        }),
      },
      { db, getApp: async () => app },
    );
    const manifest = await reader.manifest(app.id);
    expect(manifest?.documents.map(({ id, kind, locale }) => ({ id, kind, locale }))).toEqual(
      HELP_KINDS.map((kind) => ({ id: kind, kind, locale: "de" })),
    );
    expect(query).toHaveBeenCalledTimes(1);
  } finally {
    query.mockRestore();
    await db.close();
  }
});

test("declared access governs Help for roleless accounts and people outside old navigation audiences", async () => {
  const db = new SQL("sqlite://:memory:");
  const app: AppRegistryEntry = {
    id: "inventory",
    name: "Inventory",
    description: "Inventory",
    icon: "ti ti-package",
    routes: [],
    baseUrl: "http://inventory",
    access: { kind: "signedIn" },
    nav: { href: "/inventory", section: "primary", requiresRoles: ["admin"] },
    help: { manifestHash: "fixture", baseLocale: "en", pageBase: "/help/apps/inventory" },
  };
  const row = {
    app_id: app.id,
    app_name: app.name,
    manifest_hash: "fixture",
    locale: "en",
    document_id: "start",
    title: "Start",
    description: null,
    icon: null,
    sort_order: 1,
    kind: "task" as const,
    needs: null,
    next_id: null,
    related: [],
    markdown: "Inventory help.",
  };
  const query = spyOn(store, "queryHelp").mockImplementation(async (selection) => (selection.length ? [row] : []));
  const search = spyOn(store, "hasHelpBm25").mockResolvedValue(false);
  const person = buildProjectedUser({
    id: "11111111-1111-4111-8111-111111111111",
    provider: "local",
    profile: "guest",
    effective_admin: false,
  });
  const id = "22222222-2222-4222-8222-222222222222";
  const authorities: import("../../server/middleware/auth").RequestAuthority[] = [
    { actor: { kind: "user", user: person }, accessSubject: { type: "user", userId: person.id }, credentialKind: "session", scopes: [] },
    {
      actor: {
        kind: "service_account",
        delegatedUser: null,
        scopes: ["read"],
        serviceAccount: {
          id,
          name: "Fictional agent",
          kind: "agent",
          status: "active",
          delegatedUserId: null,
          appId: null,
          resourceType: null,
          resourceId: null,
          createdBy: null,
          createdAt: "2026-10-01T00:00:00Z",
        },
      },
      accessSubject: { type: "service_account", serviceAccountId: id },
      credentialKind: "api_key",
      scopes: ["read"],
    },
  ];
  try {
    await db`ATTACH DATABASE ':memory:' AS help`;
    await db`CREATE TABLE help.corpora (app_id TEXT, manifest_hash TEXT)`;
    await db`INSERT INTO help.corpora VALUES (${app.id}, ${"fixture"})`;
    for (const authority of authorities) {
      const reader = createHelpReader("en", authority.actor, { authority, db, getApp: async () => app, listApps: async () => [app] });
      expect((await reader.manifest(app.id))?.documents).toHaveLength(1);
      expect(await reader.list()).toHaveLength(1);
      expect(await reader.search({ query: "inventory" })).toHaveLength(1);
      expect((await reader.read({ appId: app.id, documentId: "start" }))?.markdown).toBe(row.markdown);
      const denied = { ...app, access: { kind: "roles" as const, roles: ["admin" as const] } };
      const blocked = createHelpReader("en", authority.actor, {
        authority,
        db,
        getApp: async () => denied,
        listApps: async () => [denied],
      });
      expect(await blocked.manifest(app.id)).toBeNull();
      expect(await blocked.list()).toEqual([]);
      expect(await blocked.search({ query: "inventory" })).toEqual([]);
      expect(await blocked.read({ appId: app.id, documentId: "start" })).toBeNull();
    }
  } finally {
    query.mockRestore();
    search.mockRestore();
    await db.close();
  }
});
