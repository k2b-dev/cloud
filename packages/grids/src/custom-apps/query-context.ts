import type { DateContext } from "@k2b/stdlib";
import { dates } from "@k2b/stdlib";
import { normalizeTimeZone } from "@valentinkolb/cloud/shared";
import type { DslQueryContextValues } from "../query-dsl/parameters";

type RuntimeUser = { id: string; displayName: string; uid: string; mail: string | null };

export const buildCustomAppQueryContext = (params: {
  user: RuntimeUser | null;
  authSubjectIds: readonly string[];
  app: { shortId: string; name: string };
  base: { shortId: string; name: string };
  page: { id: string; title: string };
  pageUrl: string;
  pageParams: Readonly<Record<string, string>>;
  dateConfig: DateContext;
  now: Date;
}): DslQueryContextValues => {
  const timeZone = normalizeTimeZone(params.dateConfig.timeZone, "UTC");
  return {
    "auth.id": params.user?.id ?? null,
    "auth.name": params.user?.displayName ?? null,
    "auth.username": params.user?.uid ?? null,
    "auth.email": params.user?.mail ?? null,
    "auth.subjects": [...new Set(params.authSubjectIds)],
    "page.id": params.page.id,
    "page.title": params.page.title,
    "page.url": params.pageUrl,
    "app.id": params.app.shortId,
    "app.name": params.app.name,
    "base.id": params.base.shortId,
    "base.name": params.base.name,
    "time.now": params.now.toISOString(),
    "time.today": dates.formatDateKey(params.now, { ...params.dateConfig, timeZone }),
    "time.timeZone": timeZone,
    ...Object.fromEntries(Object.entries(params.pageParams).map(([name, value]) => [`params.${name}`, value])),
  };
};
