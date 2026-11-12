import type { CodeCheckedVersionManifest } from "@k2b/cloud/contracts";
import type { CodePageEvent } from "@k2b/cloud/ssr/code-page/data";
import { type catalogCache, describeEvent, type LoadCodePageOptions } from "@k2b/cloud/ssr/code-page/load";

/** One automation as the switch-on card and the administration read it: everything that names it, no handler detail. */
export type CodeAutomationView = {
  entrypoint: string;
  title?: string;
  route?: { method: string; path: string; public: boolean };
  event?: CodePageEvent;
  cron?: string;
  at?: string;
  timeZone?: string;
};

/**
 * A version's automations named as the Code page names them: a reviewed title, an event by its catalog title and place,
 * a page by its method, path and audience, a schedule by when it runs. A one-time schedule carries the zone it is read
 * in. No target or owner app is asked; a place reads by type and ID unless it is the Code's own.
 */
export const describeCodeAutomations = (
  entrypoints: CodeCheckedVersionManifest["entrypoints"],
  owner: LoadCodePageOptions["owner"],
  catalog: ReturnType<typeof catalogCache>,
  defaultTimeZone: string,
): Promise<CodeAutomationView[]> =>
  Promise.all(
    entrypoints.map(
      async ({ entrypoint, title, route, event, cron, at, timeZone }): Promise<CodeAutomationView> => ({
        entrypoint,
        ...(title === undefined ? {} : { title }),
        // Who may open a page, never how it is laid out.
        ...(route ? { route: { method: route.method, path: route.path, public: route.public } } : {}),
        ...(event ? { event: await describeEvent(event, owner, catalog) } : {}),
        ...(cron ? { cron } : {}),
        ...(at ? { at, timeZone: timeZone ?? defaultTimeZone } : {}),
      }),
    ),
  );
