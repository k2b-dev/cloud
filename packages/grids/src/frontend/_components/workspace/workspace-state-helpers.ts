import type { Base } from "../../../service";
import { resolveWorkspaceMessages } from "./messages";
import type { AuthUser, GridsWorkspaceRoute, OkWorkspaceState, WorkspaceChrome, WorkspaceCommon } from "./workspace-state-model";

const urlWithParam = (href: string, key: string, value: string) => {
  const url = new URL(href, "http://grids.local");
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
};

const urlWithoutParams = (href: string, keys: string[]) => {
  const url = new URL(href, "http://grids.local");
  for (const key of keys) url.searchParams.delete(key);
  return `${url.pathname}${url.search}`;
};

export const buildViewer = (user: AuthUser) => ({
  userId: user.id,
  userGroups: user.memberofGroupIds,
});

export const buildChrome = (href: string, base: Base, locale?: string): WorkspaceChrome => {
  const t = resolveWorkspaceMessages(locale);
  const url = new URL(href, "http://grids.local");
  const adminModeRequested = url.searchParams.get("edit") === "true";
  const trashMode = url.searchParams.get("trash") === "1";
  const currentPath = `${url.pathname}${url.search}`;
  const rememberPath = urlWithoutParams(currentPath, ["edit", "form"]);
  const editModeOnHref = urlWithParam(urlWithoutParams(currentPath, ["form"]), "edit", "true");
  const editModeOffHref = urlWithoutParams(currentPath, ["edit", "form"]);
  return {
    url,
    adminModeRequested,
    trashMode,
    rememberPath,
    editModeToggleHref: adminModeRequested ? editModeOffHref : editModeOnHref,
    titleBase: [
      { title: t.start, href: "/" },
      { title: "Grids", href: "/app/grids" },
      { title: base.name, href: `/app/grids/${base.shortId}` },
    ],
  };
};

export const okState = (common: WorkspaceCommon, route: GridsWorkspaceRoute, title = common.chrome.titleBase): OkWorkspaceState => ({
  kind: "ok",
  base: common.base,
  baseShortId: common.base.shortId,
  title,
  rememberPath: common.chrome.rememberPath,
  adminModeRequested: common.chrome.adminModeRequested,
  editModeToggleHref: common.chrome.editModeToggleHref,
  canManageBase: common.canManageBase,
  canCreateTables: common.canCreateTables,
  canUseEditMode: common.canUseEditMode,
  canUseQueryWorkspace: common.canUseQueryWorkspace,
  metadataEventCursor: common.metadataEventCursor,
  recordEventCursor: common.recordEventCursor,
  dateConfig: common.params.dateConfig,
  catalog: common.catalog,
  route,
});
