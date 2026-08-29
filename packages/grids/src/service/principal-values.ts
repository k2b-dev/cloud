import { err, fail, i18n, ok, type Result } from "@k2b/stdlib";
import { accountsAppService } from "@valentinkolb/cloud/services";
import { type PrincipalReference, PrincipalReferenceSchema } from "../field-types/principal";
import type { Field } from "./types";

export type PrincipalValueValidationDeps = {
  getUser: typeof accountsAppService.user.get;
  listEntities: typeof accountsAppService.entity.list;
};

const defaultDeps: PrincipalValueValidationDeps = {
  getUser: accountsAppService.user.get,
  listEntities: accountsAppService.entity.list,
};

const principalValueMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      signInRequired: "Sign in to select users or groups.",
      accountUnavailable: "The current account is unavailable.",
      selectionUnavailable: ({ field }: { field: string }) => `Field “${field}”: a selected user or group is unavailable.`,
    },
    de: {
      signInRequired: "Melde dich an, um Benutzer oder Gruppen auszuwählen.",
      accountUnavailable: "Das aktuelle Konto ist nicht verfügbar.",
      selectionUnavailable: ({ field }) => `Im Feld „${field}“ ist ein ausgewählter Benutzer oder eine ausgewählte Gruppe nicht verfügbar.`,
    },
  },
});

const messagesFor = (locale?: string) => principalValueMessages.resolve(locale ? [locale] : []).t;

const actorForUser = async (userId: string, deps: PrincipalValueValidationDeps) => {
  const user = await deps.getUser({ id: userId });
  if (!user) return null;
  return {
    userId: user.id,
    uid: user.uid,
    provider: user.provider,
    roles: user.roles,
  };
};

const principalValues = (data: Record<string, unknown>, fields: Field[]): Array<{ field: Field; values: PrincipalReference[] }> => {
  const result: Array<{ field: Field; values: PrincipalReference[] }> = [];
  for (const field of fields) {
    if (field.type !== "principal" || !(field.id in data)) continue;
    const raw = data[field.id];
    if (!Array.isArray(raw)) continue;
    const values = raw.flatMap((item) => {
      const parsed = PrincipalReferenceSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
    if (values.length > 0) result.push({ field, values });
  }
  return result;
};

export const principalReferencesFromValue = (value: unknown): PrincipalReference[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = PrincipalReferenceSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
};

export const principalReferencesFromRecords = (
  records: readonly { data: Record<string, unknown> }[],
  fields: readonly Field[],
): PrincipalReference[] => {
  const principalFieldIds = fields.filter((field) => field.type === "principal").map((field) => field.id);
  return records.flatMap((record) => principalFieldIds.flatMap((fieldId) => principalReferencesFromValue(record.data[fieldId])));
};

/** Resolve labels only through the current actor's directory scope. */
export const buildPrincipalLabelCache = async (
  references: readonly PrincipalReference[],
  actorId: string | null,
  deps: PrincipalValueValidationDeps = defaultDeps,
): Promise<Record<string, string>> => {
  if (!actorId || references.length === 0) return {};
  const actor = await actorForUser(actorId, deps);
  if (!actor) return {};
  const labels: Record<string, string> = {};
  for (const type of ["user", "group"] as const) {
    // Label hydration is presentational. Keep it to one bounded directory
    // query per kind; additional values remain "Private" instead of causing
    // query fan-out on wide result pages.
    const ids = [...new Set(references.filter((value) => value.type === type).map((value) => value.id))].slice(0, 100);
    if (ids.length === 0) continue;
    const result = await deps.listEntities({
      actor,
      kinds: [type],
      ...(type === "user" ? { userIds: ids } : { groupIds: ids }),
      pagination: { page: 1, perPage: ids.length },
    });
    for (const item of result.items) {
      if (item.kind === "user") labels[item.user.id] = item.user.displayName || item.user.uid;
      if (item.kind === "group") labels[item.group.id] = item.group.name;
    }
  }
  return labels;
};

/**
 * Revalidates every stored principal against the same account directory scope
 * the actor can search. This keeps guessed hidden UUIDs out of records even
 * when a caller bypasses the browser picker.
 */
export const validatePrincipalValuesForActor = async (
  data: Record<string, unknown>,
  fields: Field[],
  actorId: string | null,
  locale?: string,
  deps: PrincipalValueValidationDeps = defaultDeps,
): Promise<Result<void>> => {
  const messages = messagesFor(locale);
  const entries = principalValues(data, fields);
  if (entries.length === 0) return ok();
  if (!actorId) return fail(err.forbidden(messages.signInRequired));

  const actor = await actorForUser(actorId, deps);
  if (!actor) return fail(err.forbidden(messages.accountUnavailable));

  const users = new Set<string>();
  const groups = new Set<string>();
  for (const entry of entries) {
    for (const value of entry.values) (value.type === "user" ? users : groups).add(value.id);
  }
  const visible = new Set<string>();
  const resolve = async (type: "user" | "group", ids: string[]) => {
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      const result = await deps.listEntities({
        actor,
        kinds: [type],
        ...(type === "user" ? { userIds: batch } : { groupIds: batch }),
        pagination: { page: 1, perPage: batch.length },
      });
      for (const item of result.items) {
        if (item.kind === "user") visible.add(`user:${item.user.id}`);
        if (item.kind === "group") visible.add(`group:${item.group.id}`);
      }
    }
  };
  await resolve("user", [...users]);
  await resolve("group", [...groups]);

  for (const entry of entries) {
    if (entry.values.some((value) => !visible.has(`${value.type}:${value.id}`))) {
      return fail(err.badInput(messages.selectionUnavailable({ field: entry.field.name })));
    }
  }
  return ok();
};
