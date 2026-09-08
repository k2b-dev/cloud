import type { DateContext } from "@k2b/stdlib";
import { getEffectiveGroupIds } from "@valentinkolb/cloud/server";
import type { GridsAccessContext } from "../api/permissions";
import { accessActorUser } from "../api/permissions";
import type { DslQueryContextValues } from "../query-dsl/parameters";
import type { CustomAppDefinition } from "./contracts";
import { buildCustomAppQueryContext } from "./query-context";

type RuntimeApp = { shortId: string; name: string };
type RuntimeBase = { shortId: string; name: string };
type RuntimePage = { id: string; title: string };

type CustomAppRuntimeContext = {
  query: DslQueryContextValues;
  now: Date;
};

type GlobalRuntimeContextParams = {
  access: GridsAccessContext;
  app: RuntimeApp;
  base: RuntimeBase;
  dateConfig: DateContext;
  now?: Date;
  authSubjectIds: readonly string[];
};

export const loadCustomAppAuthSubjectIds = async (access: GridsAccessContext): Promise<string[]> => {
  const user = accessActorUser(access);
  if (!user) return [];
  return [user.id, ...(await getEffectiveGroupIds({ userId: user.id }))];
};

/** Build app-global context. Page values are inert sentinels and are rejected by the global compiler contract. */
export const buildCustomAppGlobalRuntimeContext = (params: GlobalRuntimeContextParams): CustomAppRuntimeContext =>
  buildCustomAppRuntimeContext({
    ...params,
    page: { id: "global", title: params.app.name },
    pageUrl: `/apps/${encodeURIComponent(params.app.shortId)}`,
    pageParams: {},
  });

/** Capture every implicit GQL value once so all work in one request observes the same clock and URL. */
export const buildCustomAppRuntimeContext = (params: {
  access: GridsAccessContext;
  app: RuntimeApp;
  base: RuntimeBase;
  page: RuntimePage;
  pageUrl: string;
  pageParams: Readonly<Record<string, string>>;
  dateConfig: DateContext;
  now?: Date;
  authSubjectIds: readonly string[];
}): CustomAppRuntimeContext => {
  const now = params.now ?? new Date();
  const user = accessActorUser(params.access);
  return {
    now,
    query: buildCustomAppQueryContext({ ...params, user: user ?? null, now }),
  };
};

export const customAppDefinitionWithAvailableNavigation = (
  definition: CustomAppDefinition,
  availablePageIds: ReadonlySet<string>,
): CustomAppDefinition => ({
  ...definition,
  pages: definition.pages.filter((page) => !page.navigation.visible || availablePageIds.has(page.id)),
});
