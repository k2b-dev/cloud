import { z } from "zod";
import { actionReview } from "../capabilities/reviews";
import {
  codeAccessBindings,
  codeAccessPersonAllowed,
  listCodeAccess,
  readCodeAccessManagers,
  removeCodeAccess,
  setCodeAccess,
} from "../code/access";
import { verifyCodeAccessProof } from "../code/access-proof";
import type {
  CapabilityActionDefinition,
  CapabilityDefinitions,
  CapabilityExecutionContext,
  CapabilityPresentationCatalog,
  CapabilityQueryDefinition,
} from "../contracts/capabilities";
import { CAPABILITY_MAX_RESULT_BYTES, CloudResourceReaderViewSchema } from "../contracts/capabilities";
import {
  CodeAccessListDataSchema,
  CodeAccessListInputSchema,
  CodeAccessRemoveDataSchema,
  CodeAccessRemoveInputSchema,
  type CodeAccessSetData,
  CodeAccessSetDataSchema,
  CodeAccessSetInputSchema,
} from "../contracts/code-access";
import { codeAccessMessages } from "../shared/code-access-messages";
import { canonicalLocale } from "../shared/locale";
import { activeResourcePrincipals } from "./resource-principals";

/** Author mistakes fail startup, including dynamically assembled or JavaScript declarations. */
export const validateCodeAccess = (definitions: CapabilityDefinitions): void => {
  const check = (access: object, label: string, readable: boolean) => {
    for (const [key, value] of Object.entries(access)) {
      if (![...(readable ? ["readable"] : []), "manages", "grant", "revoke", "list"].includes(key))
        throw new Error(`${label}: unsupported function ${key}`);
      if (typeof value !== "function") throw new Error(`${label}.${key} must be a function`);
    }
    const functions = ["manages", "grant", "revoke", "list"];
    const present = functions.filter((key) => Object.hasOwn(access, key));
    if ((!readable || present.length > 0) && present.length !== functions.length)
      throw new Error(`${label}: manages, grant, revoke and list must all be supplied`);
  };
  const code = definitions.code;
  if (code) {
    for (const key of Object.keys(code)) if (!["access", "owners"].includes(key)) throw new Error(`code: unsupported field ${key}`);
    if (code.access) {
      for (const key of Object.keys(code.access)) if (key !== "app") throw new Error(`code.access: unsupported field ${key}`);
      if (code.access.app) check(code.access.app, "code.access.app", false);
    }
    if (code.owners && !Array.isArray(code.owners)) throw new Error("code.owners must be a list of declared types");
  }
  for (const [id, type] of Object.entries(definitions.types ?? {})) if (type.access) check(type.access, `Resource type ${id} access`, true);
  const lifecycleTypes = new Set([
    ...(code?.owners ?? []),
    ...Object.entries(definitions.types ?? {})
      .filter(([, type]) => type.access?.grant)
      .map(([id]) => id),
  ]);
  for (const id of lifecycleTypes) {
    const type = Object.hasOwn(definitions.types ?? {}, id) ? definitions.types?.[id] : undefined;
    if (!type?.reader) throw new Error(`Code lifecycle: ${id} must be a declared type with a reader`);
    const reader = definitions.queries?.[type.reader];
    if (reader && typeof reader.codeResourceTitle !== "function")
      throw new Error(`Code lifecycle: ${id} reader must supply codeResourceTitle for lifecycle checks`);
  }
};

/** Reject unknown, foreign and unrelated operations before an application chooses a level. */
export const codeAccessOperationsAllowed = (
  appId: string,
  definitions: CapabilityDefinitions,
  target: { type: string; id: string },
  operations: readonly string[],
): boolean =>
  operations.every((id) => {
    if (!id.startsWith(`${appId}.`)) return false;
    const localId = id.slice(appId.length + 1);
    if (localId.startsWith("code.access.")) return false;
    const query = definitions.queries?.[localId];
    const operation = query ?? definitions.actions?.[localId];
    if (!operation || ("code" in operation && operation.code === false)) return false;
    if (target.type === "app") return target.id === appId;
    const localType = target.type.slice(appId.length + 1);
    return (
      target.type.startsWith(`${appId}.`) &&
      ((query && query.target === undefined) || operation.target === localType || Object.values(operation.refs ?? {}).includes(localType))
    );
  });

/** A dry-run answer uses the same Type reader rule as every other platform surface. */
export const presentCodeAccessDecision = async (
  appId: string,
  definitions: CapabilityDefinitions,
  input: z.infer<typeof CodeAccessSetInputSchema>,
  decision: CodeAccessSetData,
  context: CapabilityExecutionContext,
): Promise<CodeAccessSetData> => {
  const copy = codeAccessMessages(context.locale);
  const base: CodeAccessSetData = decision.granted
    ? { granted: true, grantId: decision.grantId, level: decision.level, readable: false }
    : { granted: false, reasonCode: decision.reasonCode, reason: copy.managerRequired, readable: false };
  if (
    !codeAccessPersonAllowed(context, "set") ||
    context.actor.kind !== "user" ||
    (!decision.granted && ["proof_invalid", "origin_forbidden", "unsupported_target", "operations_invalid"].includes(decision.reasonCode))
  )
    return base;
  const type = input.target.type.startsWith(`${appId}.`) ? definitions.types?.[input.target.type.slice(appId.length + 1)] : undefined;
  const readable = type?.access?.readable;
  if (!readable) return base;
  const userId = context.actor.user.id;
  const principals = await activeResourcePrincipals([{ type: "user", userId }]);
  if (!principals.length) return base;
  const readers = await readable(
    { id: input.target.id, principals },
    {
      actor: { kind: "app", appId: "core" },
      accessSubject: { type: "none" },
      user: null,
      locale: context.locale,
      requestId: context.requestId,
      origin: context.origin,
      signal: context.signal,
    },
  );
  if (!readers.some((principal) => principal.type === "user" && principal.userId === userId)) return base;
  const result: CodeAccessSetData = { ...base, readable: true, ...(!decision.granted ? { reason: decision.reason } : {}) };
  // Actual writes need no presentation snapshot. Dry runs and refusals can explain a readable target.
  if (input.dryRun || !decision.granted) {
    const reader = type.reader ? definitions.queries?.[type.reader] : undefined;
    const parsed = reader && reader.input.safeParse({ id: input.target.id });
    if (reader && parsed?.success) {
      const read = await reader.run(parsed.data, { ...context, target: input.target });
      const view = read.ok && z.object({ view: CloudResourceReaderViewSchema }).safeParse(read.data.data);
      if (view && view.success) result.title = view.data.view.title;
    }
    let managers = decision.managerUserIds;
    if (managers === undefined && !decision.granted && decision.reasonCode === "not_manager") {
      const claims = await verifyCodeAccessProof(input.proof, {
        appId,
        target: input.target,
        operations: input.operations,
        activatingPerson: userId,
      });
      if (claims) managers = (await readCodeAccessManagers(appId, codeAccessBindings(appId, definitions), claims)) ?? undefined;
    }
    if (managers !== undefined) result.managerUserIds = managers;
  }
  // Presentation shares the existing complete envelope budget, including refusal metadata.
  const receipt = { text: result.granted ? (input.dryRun ? copy.setAvailable : copy.setDone) : result.reason };
  if (new TextEncoder().encode(JSON.stringify({ data: result, receipt })).byteLength > CAPABILITY_MAX_RESULT_BYTES)
    return { granted: false, reasonCode: "capacity_exceeded", reason: copy.managerRequired, readable: false };
  return result;
};

/** Generated capabilities share ordinary schemas, policy, validation, routing and execution auditing. */
export const generatedCodeAccess = (
  appId: string,
  definitions: CapabilityDefinitions,
): { queries: Record<string, CapabilityQueryDefinition>; actions: Record<string, CapabilityActionDefinition> } => {
  validateCodeAccess(definitions);
  const bindings = codeAccessBindings(appId, definitions);
  const copy = codeAccessMessages(definitions.presentation?.baseLocale ?? "en");
  if (!bindings.size) return { queries: {}, actions: {} };
  const forbidden = () => ({
    ok: false as const,
    error: { code: "FORBIDDEN", message: "Core person authority required; Code origin is forbidden", status: 403 as const },
  });
  const review = (remove: boolean, locale: string) => {
    const copy = codeAccessMessages(locale);
    return actionReview(
      {
        locale: locale.toLowerCase().startsWith("de") ? "de" : "en",
        sentence: {
          action: remove ? copy.rmTitle : copy.setTitle,
          running: remove ? copy.rmRunning : copy.setRunning,
          done: remove ? copy.rmDone : copy.setDone,
          confirm: remove ? copy.rmConfirm : copy.setConfirm,
          decline: copy.cancel,
        },
      },
      {},
      { ask: "changes_access" },
    );
  };
  const actions: Record<string, CapabilityActionDefinition> = {
    "code.access.set": {
      title: copy.setTitle,
      description: copy.setDescription,
      input: CodeAccessSetInputSchema.extend({
        proof: CodeAccessSetInputSchema.shape.proof.describe(copy.setInput.proof),
        target: CodeAccessSetInputSchema.shape.target
          .extend({
            type: CodeAccessSetInputSchema.shape.target.shape.type.describe(copy.setInput["target.type"]),
            id: CodeAccessSetInputSchema.shape.target.shape.id.describe(copy.setInput["target.id"]),
          })
          .describe(copy.setInput.target),
        operations: CodeAccessSetInputSchema.shape.operations.describe(copy.setInput.operations),
        dryRun: CodeAccessSetInputSchema.shape.dryRun.describe(copy.setInput.dryRun),
      }),
      data: CodeAccessSetDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      code: false,
      unattended: false,
      policy: { ask: "changes_access" },
      review: (_input, context) =>
        codeAccessPersonAllowed(context, "set") ? { ok: true, data: review(false, context.locale) } : forbidden(),
      run: async (input, context) => {
        if (!codeAccessPersonAllowed(context, "set")) return forbidden();
        const copy = codeAccessMessages(context.locale);
        const decision = await setCodeAccess(appId, bindings, input, context, undefined, () =>
          codeAccessOperationsAllowed(appId, definitions, input.target, input.operations),
        );
        const data = await presentCodeAccessDecision(appId, definitions, input, decision, context);
        return {
          ok: true,
          data: {
            data,
            receipt: { text: data.granted ? (input.dryRun ? copy.setAvailable : copy.setDone) : data.reason },
          },
        };
      },
    },
    "code.access.rm": {
      title: copy.rmTitle,
      description: copy.rmDescription,
      input: CodeAccessRemoveInputSchema.extend({ grantId: CodeAccessRemoveInputSchema.shape.grantId.describe(copy.rmInput.grantId) }),
      data: CodeAccessRemoveDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      code: false,
      unattended: false,
      policy: { ask: "changes_access" },
      review: (_input, context) =>
        codeAccessPersonAllowed(context, "rm") ? { ok: true, data: review(true, context.locale) } : forbidden(),
      run: async (input, context) => {
        if (!codeAccessPersonAllowed(context, "rm")) return forbidden();
        const copy = codeAccessMessages(context.locale);
        const removed = await removeCodeAccess(appId, bindings, input.grantId, { context });
        return {
          ok: true,
          data: { data: { removed }, receipt: { text: removed ? copy.rmDone : copy.rmFailed } },
        };
      },
    },
  };
  const queries: Record<string, CapabilityQueryDefinition> = {
    "code.access.list": {
      title: copy.listTitle,
      description: copy.listDescription,
      input: CodeAccessListInputSchema.extend({ principal: CodeAccessListInputSchema.shape.principal.describe(copy.listInput.principal) }),
      data: CodeAccessListDataSchema,
      openWorld: false,
      run: async (input, context) =>
        codeAccessPersonAllowed(context, "list")
          ? { ok: true, data: { data: await listCodeAccess(appId, bindings, input.principal, context) } }
          : forbidden(),
    },
  };
  return { queries, actions };
};

/** Generated copy belongs to the platform; apps may override its presentation like other operations. */
export const codeAccessPresentation = (presentation?: CapabilityPresentationCatalog): CapabilityPresentationCatalog => {
  const translations = { ...presentation?.translations };
  for (const locale of ["en", "de"]) {
    if (locale === (canonicalLocale(presentation?.baseLocale) ?? "en")) continue;
    const copy = codeAccessMessages(locale);
    const existing = translations[locale];
    translations[locale] = {
      ...existing,
      queries: {
        ...existing?.queries,
        "code.access.list": {
          title: copy.listTitle,
          description: copy.listDescription,
          ...existing?.queries?.["code.access.list"],
          input: { ...copy.listInput, ...existing?.queries?.["code.access.list"]?.input },
        },
      },
      actions: {
        ...existing?.actions,
        "code.access.set": {
          title: copy.setTitle,
          description: copy.setDescription,
          ...existing?.actions?.["code.access.set"],
          input: { ...copy.setInput, ...existing?.actions?.["code.access.set"]?.input },
        },
        "code.access.rm": {
          title: copy.rmTitle,
          description: copy.rmDescription,
          ...existing?.actions?.["code.access.rm"],
          input: { ...copy.rmInput, ...existing?.actions?.["code.access.rm"]?.input },
        },
      },
    };
  }
  return { ...presentation, baseLocale: presentation?.baseLocale ?? "en", translations };
};
