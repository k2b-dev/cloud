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
