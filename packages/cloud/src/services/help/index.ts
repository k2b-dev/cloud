import { type SQL, sql } from "bun";
import { getApp, listApps } from "../../_internal/registry";
import type { AppRegistryEntry } from "../../contracts/registry";
import { resolveAppPresentations } from "../../shared/app-presentation";
import { helpLocaleChain } from "../../shared/help";
import { logger } from "../logging";
import { HELP_RESOURCE_PAGE_SIZE, type HelpSelection, hasHelpBm25, metadata, queryHelp } from "./store";
import type { HelpReader } from "./types";

export { cleanupHelp, migrateHelp, registerHelp } from "./store";
export type { HelpArticle, HelpMatch, HelpMetadata, HelpReader, HelpReaderFactory } from "./types";

const log = logger("help");

export const createHelpReader = (
  locale: string,
  dependencies: {
    db?: SQL;
    listApps?: () => Promise<AppRegistryEntry[]>;
    getApp?: (appId: string) => Promise<AppRegistryEntry | null>;
  } = {},
): HelpReader => {
  const db = dependencies.db ?? sql;
  const select = async (appId?: string): Promise<HelpSelection[]> => {
    const apps = appId
      ? [await (dependencies.getApp ?? getApp)(appId)].filter((app): app is AppRegistryEntry => app !== null)
      : await (dependencies.listApps ?? listApps)();
    return resolveAppPresentations(apps, locale).flatMap((app) =>
      app.help
        ? [
            {
              app_id: app.id,
              app_name: app.name,
              manifest_hash: app.help.manifestHash,
              locales: helpLocaleChain(locale, app.help.baseLocale),
            },
          ]
        : [],
    );
  };
  return {
    async manifest(appId) {
      const app = await (dependencies.getApp ?? getApp)(appId);
      if (!app?.help) return null;
      const [corpus] = await db`SELECT 1 FROM help.corpora WHERE app_id=${app.id} AND manifest_hash=${app.help.manifestHash}`;
      if (!corpus) return null;
      const rows = await queryHelp(
        [
          {
            app_id: app.id,
            app_name: app.name,
            manifest_hash: app.help.manifestHash,
            locales: helpLocaleChain(locale, app.help.baseLocale),
          },
        ],
        {},
        db,
      );
      return {
        ...app.help,
        locale,
        documents: rows
          .sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title))
          .map((row) => ({
            id: row.document_id,
            title: row.title,
            icon: row.icon ?? undefined,
            description: row.description ?? undefined,
            order: row.sort_order,
            locale: row.locale,
            searchUrl: `/api/help/v1/${encodeURIComponent(appId)}/search`,
            url: `/api/help/v1/${encodeURIComponent(appId)}/documents/${encodeURIComponent(row.document_id)}`,
          })),
      };
    },
    async list(cursor = "") {
      return (await queryHelp(await select(), { cursor, limit: HELP_RESOURCE_PAGE_SIZE + 1 }, db)).map(metadata);
    },
    async read(input) {
      const [row] = await queryHelp(await select(input.appId), { documentId: input.documentId, body: true, limit: 1 }, db);
      return row?.markdown === undefined ? null : { ...metadata(row), markdown: row.markdown };
    },
    async search(input) {
      const query = input.query.trim().slice(0, 200);
      if (!query) return [];
      const selection = await select(input.appId);
      if (!selection.length) return [];
      const options = { query, limit: Math.max(1, Math.min(Math.floor(Number.isFinite(input.limit) ? input.limit! : 10), 25)) };
      const bm25 = await hasHelpBm25(db);
      const rows = await queryHelp(selection, { ...options, bm25 }, db).catch((error: unknown) => {
        // Only missing optional SQL objects qualify for fallback, not connection/query errors.
        const code = error && typeof error === "object" ? (Reflect.get(error, "errno") ?? Reflect.get(error, "code")) : undefined;
        if (!bm25 || !["42883", "42704", "42P01"].includes(String(code))) throw error;
        log.warn("BM25 unavailable; using native Help search");
        return queryHelp(selection, options, db);
      });
      return rows.map((row) => ({
        kind: "help",
        appId: row.app_id,
        appName: row.app_name,
        locale: row.locale,
        documentId: row.document_id,
        title: row.title,
        description: row.description ?? undefined,
      }));
    },
  };
};
export { startHelpMaintenance } from "./maintenance";
