import { getApp } from "@k2b/cloud";
import { type CapabilityCatalogApp, getCapabilityCatalogApp, listCapabilityCatalog } from "@k2b/cloud/capabilities/server";
import {
  CapabilityAppIdSchema,
  type CapabilityContractIssue,
  CONTACT_DIRECTORY_FUNCTIONS,
  type ContactDirectoryFunction,
  capabilityContractIssues,
  contactDirectory,
} from "@k2b/cloud/contracts";
import { invalidateSettingsCache, read, SettingUnreadableError, set } from "@k2b/cloud/services/settings";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { Context } from "hono";
import { app } from "../config";
import { contactDirectoryMessages } from "../contact-directory-messages";
import {
  MAIL_CONTACT_DIRECTORY_DEFAULTS,
  MAIL_CONTACT_DIRECTORY_REQUIRED,
  MAIL_CONTACT_DIRECTORY_SETTING_KEYS,
  type MailContactDirectory,
  type MailContactDirectoryConfig,
  requestContactDirectoryConfig,
  resolveMailContactDirectory,
} from "../contact-directory-settings";
import { isCurrentPlatformAdmin } from "./access";
import type { MailRequestContext } from "./auth";

export type ContactDirectoryCapabilityOption = { id: string; title: string };
export type ContactDirectoryAppOption = {
  appId: string;
  appName: string;
  appIcon: string;
  capabilities: Record<ContactDirectoryFunction, ContactDirectoryCapabilityOption[]>;
};

export type ContactDirectoryField = "appId" | ContactDirectoryFunction;
export type ContactDirectoryIssue = {
  field: ContactDirectoryField;
  code:
    | "app_missing"
    | "required"
    | "capability_missing"
    | "wrong_kind"
    | "unsupported_operation"
    | "input_mismatch"
    | "data_mismatch"
    | "paired_function";
  message: string;
};

export type ContactDirectorySettingKey = (typeof MAIL_CONTACT_DIRECTORY_SETTING_KEYS)[keyof typeof MAIL_CONTACT_DIRECTORY_SETTING_KEYS];
/** Platform seams; tests replace them instead of touching the catalog, accounts, or shared settings. */
export type ContactDirectoryDependencies = {
  listCatalog: typeof listCapabilityCatalog;
  getCatalogApp: typeof getCapabilityCatalogApp;
  isAdmin: (context: MailRequestContext) => Promise<boolean>;
  readSetting: (key: ContactDirectorySettingKey, tx?: typeof sql) => Promise<{ value: string; stored: "none" | "readable" | "unreadable" }>;
  writeSetting: (key: ContactDirectorySettingKey, value: string, options: { replaceUnreadable?: boolean }, tx: typeof sql) => Promise<void>;
  transaction: (write: (tx: typeof sql) => Promise<ContactDirectorySaveResult>) => Promise<ContactDirectorySaveResult>;
  invalidateSettings: (keys: readonly string[]) => Promise<void>;
};
const platform: ContactDirectoryDependencies = {
  listCatalog: listCapabilityCatalog,
  getCatalogApp: getCapabilityCatalogApp,
  isAdmin: (context) => isCurrentPlatformAdmin(context),
  readSetting: async (key, tx) => {
    if (!tx) return app.settings.read(key);
    const state = await read(key, tx);
    if (typeof state.value !== "string") throw new Error(`Expected a string setting: ${key}`);
    return { ...state, value: state.value };
  },
  writeSetting: (key, value, options, tx) => set(key, value, tx, options),
  transaction: (write) => sql.begin(write),
  invalidateSettings: invalidateSettingsCache,
};

const requireAdmin = async (context: MailRequestContext, deps: ContactDirectoryDependencies): Promise<Result<void>> =>
  (await deps.isAdmin(context)) ? ok() : fail(err.forbidden("Cloud administration access is required"));

const contractIssues = (fn: ContactDirectoryFunction, catalogApp: CapabilityCatalogApp, capabilityId: string) => {
  const contract = contactDirectory[fn];
  if (contract.kind === "query") {
    const operation = catalogApp.manifest.queries.find((entry) => entry.localId === capabilityId);
    if (operation) return capabilityContractIssues(contract, { kind: "query", operation });
    return catalogApp.manifest.actions.some((entry) => entry.localId === capabilityId) ? "wrong_kind" : "missing";
  }
  const operation = catalogApp.manifest.actions.find((entry) => entry.localId === capabilityId);
  if (operation) return capabilityContractIssues(contract, { kind: "action", operation });
  return catalogApp.manifest.queries.some((entry) => entry.localId === capabilityId) ? "wrong_kind" : "missing";
};

const compatibleCapabilities = (catalogApp: CapabilityCatalogApp, fn: ContactDirectoryFunction): ContactDirectoryCapabilityOption[] => {
  const operations = contactDirectory[fn].kind === "query" ? catalogApp.manifest.queries : catalogApp.manifest.actions;
  return operations
    .filter((operation) => {
      const issues = contractIssues(fn, catalogApp, operation.localId);
      return Array.isArray(issues) && issues.length === 0;
    })
    .map((operation) => ({ id: operation.localId, title: operation.title }));
};

const functionName = (fn: ContactDirectoryFunction, t: ReturnType<typeof contactDirectoryMessages.resolve>["t"]): string => t[fn];

const issueFromContract = (
  fn: ContactDirectoryFunction,
  id: string,
  issue: CapabilityContractIssue,
  t: ReturnType<typeof contactDirectoryMessages.resolve>["t"],
): ContactDirectoryIssue => {
  const name = functionName(fn, t);
  if (issue.code === "kind") return { field: fn, code: "wrong_kind", message: t.wrongKind({ name, id, kind: contactDirectory[fn].kind }) };
  if (issue.code === "input") return { field: fn, code: "input_mismatch", message: t.inputMismatch({ name, id, path: issue.path }) };
  if (issue.code === "data") return { field: fn, code: "data_mismatch", message: t.dataMismatch({ name, id, path: issue.path }) };
  return { field: fn, code: "unsupported_operation", message: t.unsupportedOperation({ name, id }) };
};

/**
 * Explains why Mail cannot use a mapping. `catalogApp` is the provider's live
 * catalog entry, or `null` when the app is not registered.
 */
export const contactDirectoryIssues = (
  config: MailContactDirectoryConfig,
  catalogApp: CapabilityCatalogApp | null,
  locale: string,
): ContactDirectoryIssue[] => {
  const { t } = contactDirectoryMessages.resolve([locale]);
  if (!catalogApp) return [{ field: "appId", code: "app_missing", message: t.appMissing({ appId: config.appId }) }];
  const issues: ContactDirectoryIssue[] = [];
  for (const fn of CONTACT_DIRECTORY_FUNCTIONS) {
    const id = config[fn].trim();
    const name = functionName(fn, t);
    if (!id) {
      if (MAIL_CONTACT_DIRECTORY_REQUIRED.some((required) => required === fn))
        issues.push({ field: fn, code: "required", message: t.required({ name }) });
      continue;
    }
    const found = contractIssues(fn, catalogApp, id);
    if (found === "missing") issues.push({ field: fn, code: "capability_missing", message: t.capabilityMissing({ name, id }) });
    else if (found === "wrong_kind")
      issues.push({ field: fn, code: "wrong_kind", message: t.wrongKind({ name, id, kind: contactDirectory[fn].kind }) });
    else if (found[0]) issues.push(issueFromContract(fn, id, found[0], t));
  }
  if (Boolean(config.listWritableBooks.trim()) !== Boolean(config.create.trim())) {
    const field = config.create.trim() ? "listWritableBooks" : "create";
    issues.push({ field, code: "paired_function", message: t.pairedFunction });
  }
  return issues;
};

const loadCatalogApps = async (locale: string, deps: ContactDirectoryDependencies): Promise<CapabilityCatalogApp[] | null> => {
  const apps: CapabilityCatalogApp[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page = await deps.listCatalog({ cursor, limit: 25, locale });
    if (!page.ok) return null;
    apps.push(...page.data.apps);
    if (!page.data.page.hasMore) return apps;
    const nextCursor = page.data.page.nextCursor;
    if (seenCursors.has(nextCursor)) return null;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
};

export type ContactDirectoryAdminView = {
  unreadable?: Partial<Record<ContactDirectorySettingKey, boolean>>;
  config: MailContactDirectoryConfig;
  /** `null` when the capability catalog could not be read. */
  apps: ContactDirectoryAppOption[] | null;
  issues: ContactDirectoryIssue[];
};

/** Loads the admin form: installed apps with their compatible capabilities and problems with the saved mapping. */
export const loadContactDirectoryAdmin = async (
  context: MailRequestContext,
  config: MailContactDirectoryConfig,
  locale: string,
  overrides: Partial<ContactDirectoryDependencies> = {},
): Promise<Result<ContactDirectoryAdminView>> => {
  const deps = { ...platform, ...overrides };
  const admin = await requireAdmin(context, deps);
  if (!admin.ok) return admin;
  const unreadable: Partial<Record<ContactDirectorySettingKey, boolean>> = {};
  for (const field of ["appId", ...CONTACT_DIRECTORY_FUNCTIONS] as const) {
    const key = MAIL_CONTACT_DIRECTORY_SETTING_KEYS[field];
    const state = await deps.readSetting(key);
    config = { ...config, [field]: state.value };
    unreadable[key] = state.stored === "unreadable";
  }
  const catalogApps = await loadCatalogApps(locale, deps);
  const apps =
    catalogApps
      ?.map((catalogApp) => ({
        appId: catalogApp.appId,
        appName: catalogApp.appName,
        appIcon: catalogApp.appIcon,
        capabilities: {
          suggest: compatibleCapabilities(catalogApp, "suggest"),
          resolve: compatibleCapabilities(catalogApp, "resolve"),
          read: compatibleCapabilities(catalogApp, "read"),
          listWritableBooks: compatibleCapabilities(catalogApp, "listWritableBooks"),
          create: compatibleCapabilities(catalogApp, "create"),
        },
      }))
      .sort((left, right) => left.appName.localeCompare(right.appName, locale, { sensitivity: "base" })) ?? null;
  const current = catalogApps?.find((catalogApp) => catalogApp.appId === config.appId) ?? null;
  return ok({ config, apps, unreadable, issues: catalogApps ? contactDirectoryIssues(config, current, locale) : [] });
};

export type ContactDirectorySaveResult =
  | { ok: true; config: MailContactDirectoryConfig }
  | { ok: false; status: 400; issues: ContactDirectoryIssue[] }
  | { ok: false; status: 403 | 503; message: string };

/** Validates a mapping against the provider's live catalog and stores it only when Mail can use it. */
export const saveContactDirectory = async (
  context: MailRequestContext,
  input: Partial<MailContactDirectoryConfig> & { replaceUnreadable?: ContactDirectorySettingKey[] },
  locale: string,
  overrides: Partial<ContactDirectoryDependencies> = {},
): Promise<ContactDirectorySaveResult> => {
  const deps = { ...platform, ...overrides };
  const admin = await requireAdmin(context, deps);
  if (!admin.ok) return { ok: false, status: 403, message: admin.error.message };
  const changed: ContactDirectorySettingKey[] = [];
  const saved = await deps.transaction(async (tx): Promise<ContactDirectorySaveResult> => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('mail.contact-directory-settings', 0))`;
    const config: MailContactDirectoryConfig = { ...MAIL_CONTACT_DIRECTORY_DEFAULTS };
    // Merge and validate the latest mapping while holding the same lock as every other save.
    for (const field of ["appId", ...CONTACT_DIRECTORY_FUNCTIONS] as const) {
      const key = MAIL_CONTACT_DIRECTORY_SETTING_KEYS[field];
      const state = await deps.readSetting(key, tx);
      if (input[field] !== undefined && state.stored === "unreadable" && !input.replaceUnreadable?.includes(key))
        throw new SettingUnreadableError(key);
      config[field] = (input[field] ?? state.value).trim();
    }
    const catalog = await deps.getCatalogApp(config.appId, locale);
    if (!catalog.ok) return { ok: false, status: 503, message: catalog.error.message };
    const issues = contactDirectoryIssues(config, catalog.data, locale);
    if (issues.length > 0) return { ok: false, status: 400, issues };
    for (const field of ["appId", ...CONTACT_DIRECTORY_FUNCTIONS] as const) {
      const key = MAIL_CONTACT_DIRECTORY_SETTING_KEYS[field];
      if (input[field] !== undefined) {
        await deps.writeSetting(key, config[field], { replaceUnreadable: input.replaceUnreadable?.includes(key) === true }, tx);
        changed.push(key);
      }
    }
    return { ok: true, config };
  });
  if (saved.ok) await deps.invalidateSettings(changed);
  return saved;
};

/** A request-local registry read distinguishes an absent provider from a failed call. */
const defaultIsRegistered = async (appId: string): Promise<boolean> => (await getApp(appId)) !== null;

export const resolveRegisteredContactDirectory = async (
  config: MailContactDirectoryConfig,
  isRegistered: (appId: string) => Promise<boolean> = defaultIsRegistered,
): Promise<MailContactDirectory> => {
  const mapped = resolveMailContactDirectory(config);
  if (!CapabilityAppIdSchema.safeParse(config.appId.trim()).success) return mapped;
  try {
    if (!(await isRegistered(config.appId.trim())))
      return { suggest: null, resolve: null, read: null, listWritableBooks: null, create: null };
  } catch {
    // Registry failure is transient. Keep the targets so callers offer Retry.
  }
  return mapped;
};

export const requestContactDirectory = async (
  c: Context,
  deps: { isRegistered: (appId: string) => Promise<boolean> } = { isRegistered: defaultIsRegistered },
): Promise<MailContactDirectory> => resolveRegisteredContactDirectory(requestContactDirectoryConfig(c), deps.isRegistered);
