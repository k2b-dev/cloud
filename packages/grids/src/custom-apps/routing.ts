import { z } from "zod";
import type {
  CustomAppAction,
  CustomAppDefinition,
  CustomAppFormBlock,
  CustomAppPage,
  CustomAppRowNavigation,
  CustomAppSidebarAction,
} from "./contracts";

const RecordIdSchema = z.string().uuid();

const querySuffix = (params: Record<string, string>): string => {
  const search = new URLSearchParams();
  for (const key of Object.keys(params).sort()) search.set(key, params[key]!);
  const query = search.toString();
  return query ? `?${query}` : "";
};

const customAppRuntimeUrl = (
  shortId: string,
  pageId: string,
  blockId: string,
  segments: readonly string[],
  params: Record<string, string>,
): string => `/api/grids/apps/runtime/${[shortId, pageId, blockId, ...segments].map(encodeURIComponent).join("/")}${querySuffix(params)}`;

export const resolveCustomAppPage = (definition: CustomAppDefinition, requestedPageId?: string): CustomAppPage | null => {
  const pageId = requestedPageId || definition.startPageId;
  return definition.pages.find((page) => page.id === pageId) ?? null;
};

export const resolvePageRecordId = (page: CustomAppPage, query: Record<string, string>): string | null | undefined => {
  if (!page.record) return undefined;
  const value = query[page.record.id.path];
  if (!value) return null;
  const parsed = RecordIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export const resolveCustomAppPageParams = (page: CustomAppPage, query: Record<string, string>): Record<string, string> | null => {
  const params: Record<string, string> = {};
  for (const parameterId of Object.keys(page.parameters)) {
    const value = query[parameterId];
    if (!value) return null;
    const parsed = RecordIdSchema.safeParse(value);
    if (!parsed.success) return null;
    params[parameterId] = parsed.data;
  }
  return params;
};

export const customAppPageHref = (shortId: string, pageId: string, params: Record<string, string> = {}): string => {
  const path = `/apps/${encodeURIComponent(shortId)}/${encodeURIComponent(pageId)}`;
  return `${path}${querySuffix(params)}`;
};

/** A static sidebar target supplies only the page's existing record parameter. */
export const customAppNavigationParams = (page: CustomAppPage): Record<string, string> =>
  page.record && page.navigation.recordId ? { [page.record.id.path]: page.navigation.recordId } : {};

export const customAppNavigationHref = (shortId: string, page: CustomAppPage): string =>
  customAppPageHref(shortId, page.id, customAppNavigationParams(page));

export const customAppFormSubmitUrl = (shortId: string, pageId: string, blockId: string, params: Record<string, string>): string =>
  customAppRuntimeUrl(shortId, pageId, blockId, ["submit"], params);

export const customAppSidebarFormSubmitUrl = (shortId: string, actionId: string): string =>
  `/api/grids/apps/runtime/${encodeURIComponent(shortId)}/sidebar/forms/${encodeURIComponent(actionId)}/submit`;

export const customAppCommentsUrl = (shortId: string, pageId: string, blockId: string, params: Record<string, string>): string =>
  customAppRuntimeUrl(shortId, pageId, blockId, ["comments"], params);

export const customAppRecordUpdateUrl = (shortId: string, pageId: string, blockId: string, params: Record<string, string>): string =>
  customAppRuntimeUrl(shortId, pageId, blockId, ["record"], params);

export const customAppRecordFilesUrl = (
  shortId: string,
  pageId: string,
  blockId: string,
  fieldId: string,
  params: Record<string, string>,
): string => {
  return customAppRuntimeUrl(shortId, pageId, blockId, ["record", "files", fieldId], params);
};

export const customAppActionUrl = (
  shortId: string,
  pageId: string,
  blockId: string,
  actionId: string,
  params: Record<string, string>,
): string => {
  return customAppRuntimeUrl(shortId, pageId, blockId, ["actions", actionId], params);
};

export const customAppRowActionUrl = (
  shortId: string,
  pageId: string,
  blockId: string,
  actionId: string,
  params: Record<string, string>,
): string => {
  return customAppRuntimeUrl(shortId, pageId, blockId, ["row-actions", actionId], params);
};

export const customAppRecordsUrl = (shortId: string, pageId: string, blockId: string, params: Record<string, string>): string =>
  customAppRuntimeUrl(shortId, pageId, blockId, ["records"], params);

export const customAppActionStatusUrl = (
  shortId: string,
  pageId: string,
  blockId: string,
  actionId: string,
  runId: string,
  params: Record<string, string>,
): string => {
  return customAppRuntimeUrl(shortId, pageId, blockId, ["actions", actionId, "runs", runId], params);
};

export const customAppScannerUrl = (shortId: string, pageId: string, blockId: string, params: Record<string, string>): string =>
  customAppRuntimeUrl(shortId, pageId, blockId, ["scanner"], params);

export const customAppScannerRunUrl = (
  shortId: string,
  pageId: string,
  blockId: string,
  runId: string,
  params: Record<string, string>,
): string => {
  return customAppRuntimeUrl(shortId, pageId, blockId, ["scanner", "runs", runId], params);
};

export const customAppDocumentDownloadUrl = (
  shortId: string,
  pageId: string,
  blockId: string,
  runId: string,
  params: Record<string, string>,
): string => {
  return customAppRuntimeUrl(shortId, pageId, blockId, ["documents", runId, "download"], params);
};

export const customAppDocumentPreviewUrl = (
  shortId: string,
  pageId: string,
  blockId: string,
  templateId: string,
  params: Record<string, string>,
): string => customAppRuntimeUrl(shortId, pageId, blockId, ["document-previews", templateId], params);

export const customAppActionHref = (
  shortId: string,
  action: Extract<CustomAppAction, { kind: "navigate" }>,
  pageParams: Record<string, string>,
  recordId?: string,
  relationParams: Readonly<Record<string, string>> = {},
): string | null => {
  const params: Record<string, string> = {};
  for (const [parameterId, value] of Object.entries(action.params)) {
    const resolved =
      value.source === "PARAMS" ? pageParams[value.path] : value.path === "relation" ? relationParams[parameterId] : recordId;
    if (!resolved) return null;
    params[parameterId] = resolved;
  }
  return customAppPageHref(shortId, action.pageId, params);
};

export const customAppRowHref = (
  shortId: string,
  navigation: CustomAppRowNavigation,
  recordId: string,
  resolvedParams: Readonly<Record<string, string>> = {},
): string | null => {
  const params: Record<string, string> = {};
  for (const [parameterId, binding] of Object.entries(navigation.params)) {
    const value = binding.path === "id" ? recordId : resolvedParams[parameterId];
    if (!value) return null;
    params[parameterId] = value;
  }
  return customAppPageHref(shortId, navigation.pageId, params);
};

export const customAppFormSuccessHref = (
  shortId: string,
  navigation: NonNullable<CustomAppFormBlock["onSuccessNavigate"]>,
  pageParams: Record<string, string>,
  recordId: string,
): string =>
  customAppPageHref(
    shortId,
    navigation.pageId,
    Object.fromEntries(
      Object.entries(navigation.params).map(([parameterId, value]) => [
        parameterId,
        value.source === "RESULT" ? recordId : pageParams[value.path]!,
      ]),
    ),
  );

export const customAppSidebarFormSuccessHref = (
  shortId: string,
  navigation: NonNullable<Extract<CustomAppSidebarAction, { kind: "form" }>["onSuccessNavigate"]>,
  recordId: string,
): string =>
  customAppPageHref(
    shortId,
    navigation.pageId,
    Object.fromEntries(Object.keys(navigation.params).map((parameterId) => [parameterId, recordId])),
  );
