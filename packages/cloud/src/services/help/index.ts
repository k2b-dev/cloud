import { type SQL, sql } from "bun";
import { appAudienceRoles, hasAnyAppRole } from "../../_internal/app-roles";
import { getApp, listApps } from "../../_internal/registry";
import type { AppRegistryEntry } from "../../contracts/registry";
import type { RequestActor } from "../../contracts/shared";
import { resolveAppPresentations } from "../../shared/app-presentation";
import { type HelpArticleLink, helpLocaleChain, parseHelpReference } from "../../shared/help";
import { lexHelpMarkdown, walkHelpTokens } from "../../shared/markdown";
import { logger } from "../logging";
import { HELP_RESOURCE_PAGE_SIZE, type HelpSelection, hasHelpBm25, metadata, queryHelp } from "./store";
import type { HelpReader } from "./types";

export { cleanupHelp, migrateHelp, registerHelp } from "./store";
export type { HelpArticle, HelpMatch, HelpMetadata, HelpReader, HelpReaderFactory } from "./types";

const log = logger("help");

/**
 * Help follows the app's declared visibility: it needs a user (the person, or the user an API credential acts
 * for), the app's navigation roles limit it, and an app reached only through the admin area is for admins.
 * The app's routes still authorize the app itself.
 */
export const canReadAppHelp = (app: Pick<AppRegistryEntry, "nav">, viewer: RequestActor | undefined): boolean => {
  const user = viewer?.kind === "user" ? viewer.user : (viewer?.delegatedUser ?? undefined);
  return !!user && hasAnyAppRole(user, appAudienceRoles(app.nav));
};

/** Reads Help in one language for one viewer; apps the viewer may not see do not exist for this reader. */
export const createHelpReader = (
  locale: string,
  viewer: RequestActor | undefined,
  dependencies: {
    db?: SQL;
    listApps?: () => Promise<AppRegistryEntry[]>;
    getApp?: (appId: string) => Promise<AppRegistryEntry | null>;
  } = {},
): HelpReader => {
  const db = dependencies.db ?? sql;
  const visible = (app: AppRegistryEntry | null): app is AppRegistryEntry => app !== null && canReadAppHelp(app, viewer);
  const selectionFor = (apps: AppRegistryEntry[]): HelpSelection[] =>
    apps.flatMap((app) =>
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
  const select = async (appId?: string): Promise<HelpSelection[]> => {
    const apps = appId ? [await (dependencies.getApp ?? getApp)(appId)] : await (dependencies.listApps ?? listApps)();
    return selectionFor(resolveAppPresentations(apps.filter(visible), locale));
  };
  return {
    async manifest(appId) {
      const app = await (dependencies.getApp ?? getApp)(appId);
      if (!visible(app) || !app.help) return null;
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
      if (row?.markdown === undefined) return null;
      const references = new Set<string>();
      const add = (reference: string) => {
        const ref = parseHelpReference(reference);
        if (ref) references.add(`${ref.appId ?? input.appId}/${ref.documentId}`);
      };
      if (row.next_id) add(row.next_id);
      for (const reference of row.related) add(reference);
      walkHelpTokens(lexHelpMarkdown(row.markdown, row.locale), (token) => {
        if (token.type === "link" && token.href.startsWith("help:")) add(token.href.slice(5));
      });
      // Only targets in the current Help of apps this viewer may see become links; the rest stay text.
      const referencedApps = new Set([...references].map((reference) => reference.split("/")[0]));
      const apps = references.size
        ? resolveAppPresentations(
            (referencedApps.size === 1 && referencedApps.has(input.appId)
              ? [await (dependencies.getApp ?? getApp)(input.appId)]
              : await (dependencies.listApps ?? listApps)()
            ).filter((app): app is AppRegistryEntry => visible(app) && referencedApps.has(app.id)),
            locale,
          )
        : [];
      const targets = apps.length ? await queryHelp(selectionFor(apps), { references: [...references] }, db) : [];
      const accents = new Map(apps.map((app) => [app.id, app.appearance?.accent]));
      const links: Record<string, HelpArticleLink> = {};
      for (const target of targets) {
        links[`${target.app_id}/${target.document_id}`] = {
          appId: target.app_id,
          appName: target.app_name,
          accent: accents.get(target.app_id),
          documentId: target.document_id,
          title: target.title,
          description: target.description ?? undefined,
          icon: target.icon ?? undefined,
          url: `/help/apps/${encodeURIComponent(target.app_id)}/${encodeURIComponent(target.document_id)}`,
        };
      }
      return { ...metadata(row), markdown: row.markdown, links };
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
