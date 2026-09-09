import type { getDateConfig } from "@k2b/cloud/server";
import { ShortIdSchema } from "../contracts";
import type { CustomAppAction, CustomAppBlock, CustomAppRowAction } from "../custom-apps/contracts";
import { customAppPageHref, resolveCustomAppPage } from "../custom-apps/routing";
import {
  buildCustomAppGlobalRuntimeContext,
  buildCustomAppRuntimeContext,
  loadCustomAppAuthSubjectIds,
} from "../custom-apps/runtime-context";
import { gridsService } from "../service";
import { publishedCustomAppAvailability } from "../service/custom-app-runtime-query";
import { resolvePublicIds } from "../service/public-resources";
import { actorViewerFor, type GridsAccessContext, gateCustomAppAtAccess } from "./permissions";

type PublishedCustomAppRuntimeInput = {
  access: GridsAccessContext;
  shortId: string;
  pageId?: string;
  query: Record<string, string>;
  dateConfig: ReturnType<typeof getDateConfig>;
  signal: AbortSignal;
};

const availabilityKey = (target: string, pageId = "", blockId = "", actionId = "") => `${target}\0${pageId}\0${blockId}\0${actionId}`;

export const resolvePublishedCustomAppGlobalRuntime = async (input: PublishedCustomAppRuntimeInput) => {
  const app = await gridsService.customApp.getPublishedByShortId(input.shortId);
  if (!app?.publishedDefinition || !app.publishedCapabilities || !app.publishedAt) return null;
  if (!(await gateCustomAppAtAccess(input.access, app.id)).ok) return null;
  const base = await gridsService.base.get(app.baseId);
  if (!base) return null;
  const authSubjectIds = await loadCustomAppAuthSubjectIds(input.access);
  const globalRuntimeContext = buildCustomAppGlobalRuntimeContext({
    access: input.access,
    app,
    base,
    dateConfig: input.dateConfig,
    authSubjectIds,
  });
  const viewer = { ...actorViewerFor(input.access), isAdmin: true };
  const availabilityCapabilities = new Map(
    app.publishedCapabilities.availability.map((capability) => [
      availabilityKey(
        capability.target,
        "pageId" in capability ? capability.pageId : "",
        "blockId" in capability ? capability.blockId : "",
        "actionId" in capability ? capability.actionId : "",
      ),
      capability,
    ]),
  );
  const availableSidebarAction = async (actionId: string, query: string | undefined) => {
    if (!query) return true;
    const capability = availabilityCapabilities.get(availabilityKey("sidebarAction", "", "", actionId));
    if (!capability) return false;
    return publishedCustomAppAvailability({
      baseId: app.baseId,
      source: query,
      capability,
      context: globalRuntimeContext.query,
      signal: input.signal,
      timeZone: globalRuntimeContext.query["time.timeZone"],
      viewer,
    });
  };
  return {
    app,
    definition: app.publishedDefinition,
    capabilities: app.publishedCapabilities,
    access: input.access,
    base,
    dateConfig: input.dateConfig,
    globalRuntimeContext,
    authSubjectIds,
    viewer,
    availabilityCapabilities,
    availableSidebarAction,
  } as const;
};

export const resolvePublishedCustomAppRuntime = async (input: PublishedCustomAppRuntimeInput) => {
  const global = await resolvePublishedCustomAppGlobalRuntime(input);
  if (!global) return null;
  const { app, definition, base, authSubjectIds, viewer } = global;
  const page = resolveCustomAppPage(definition, input.pageId);
  if (!page) return null;
  const publicPageParams: Record<string, string> = {};
  for (const parameterId of Object.keys(page.parameters)) {
    const value = input.query[parameterId];
    if (!value || !ShortIdSchema.safeParse(value).success) return null;
    publicPageParams[parameterId] = value;
  }
  const records = await resolvePublicIds("record", Object.values(publicPageParams));
  if (records.size !== new Set(Object.values(publicPageParams)).size) return null;
  const pageParams = Object.fromEntries(
    Object.entries(publicPageParams).map(([parameterId, recordId]) => [parameterId, records.get(recordId!)!]),
  );
  const runtimeContext = buildCustomAppRuntimeContext({
    access: input.access,
    app,
    base,
    page,
    pageUrl: customAppPageHref(app.shortId, page.id, publicPageParams),
    pageParams: publicPageParams,
    dateConfig: input.dateConfig,
    now: global.globalRuntimeContext.now,
    authSubjectIds,
  });
  const blocks = new Map<string, CustomAppBlock>(
    page.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks.map((block) => [block.id, block] as const))),
  );
  const actions = new Map<string, CustomAppAction | CustomAppRowAction>();
  for (const block of blocks.values()) {
    if (block.type === "actions") {
      for (const action of block.actions) actions.set(`${block.id}\0${action.id}`, action);
    }
    if (block.type === "records" || block.type === "referenced_records") {
      for (const action of block.rowActions ?? []) actions.set(`${block.id}\0${action.id}`, action);
    }
  }
  // Records membership stays in custom-app-records-query: it needs the
  // request's search/cursor and must replay the current published query.
  const available = async (target: "page" | "block" | "action", query: string | undefined, blockId?: string, actionId?: string) => {
    if (!query) return true;
    const capability = global.availabilityCapabilities.get(availabilityKey(target, page.id, blockId, actionId));
    if (!capability) return false;
    return publishedCustomAppAvailability({
      baseId: app.baseId,
      source: query,
      capability,
      context: runtimeContext.query,
      signal: input.signal,
      timeZone: runtimeContext.query["time.timeZone"],
      viewer,
    });
  };
  if (!(await available("page", page.availableWhen?.query))) return null;
  return {
    ...global,
    page,
    publicPageParams,
    pageParams,
    runtimeContext,
    blocks,
    actions,
    available,
  } as const;
};
