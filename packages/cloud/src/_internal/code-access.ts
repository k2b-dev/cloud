import { actionReview } from "../capabilities/reviews";
import { codeAccessBindings, codeAccessPersonAllowed, listCodeAccess, removeCodeAccess, setCodeAccess } from "../code/access";
import type { CapabilityActionDefinition, CapabilityDefinitions, CapabilityQueryDefinition } from "../contracts/capabilities";
import {
  CodeAccessListDataSchema,
  CodeAccessListInputSchema,
  CodeAccessRemoveDataSchema,
  CodeAccessRemoveInputSchema,
  CodeAccessSetDataSchema,
  CodeAccessSetInputSchema,
} from "../contracts/code-access";

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
  for (const id of code?.owners ?? []) {
    const type = Object.hasOwn(definitions.types ?? {}, id) ? definitions.types?.[id] : undefined;
    if (!type?.reader) throw new Error(`code.owners: ${id} must be a declared type with a reader`);
  }
};

/** Generated capabilities share ordinary schemas, policy, validation, routing and execution auditing. */
export const generatedCodeAccess = (
  appId: string,
  definitions: CapabilityDefinitions,
): { queries: Record<string, CapabilityQueryDefinition>; actions: Record<string, CapabilityActionDefinition> } => {
  validateCodeAccess(definitions);
  const bindings = codeAccessBindings(appId, definitions);
  if (!bindings.size) return { queries: {}, actions: {} };
  const forbidden = () => ({
    ok: false as const,
    error: { code: "FORBIDDEN", message: "Core person authority required; Code origin is forbidden", status: 403 as const },
  });
  const review = (remove: boolean) =>
    actionReview(
      {
        locale: "en",
        sentence: {
          action: remove ? "Remove Code access" : "Grant Code access",
          running: remove ? "Removing Code access" : "Granting Code access",
          done: remove ? "Code access removed" : "Code access granted",
          confirm: remove ? "Remove access" : "Grant access",
          decline: "Cancel",
        },
      },
      {},
      { ask: "changes_access" },
    );
  const actions: Record<string, CapabilityActionDefinition> = {
    "code.access.set": {
      title: "Grant Code access",
      description: "Core activates explicit Code access at a target with a signed activation proof.",
      input: CodeAccessSetInputSchema,
      data: CodeAccessSetDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      code: false,
      unattended: false,
      policy: { ask: "changes_access" },
      review: (_input, context) => (codeAccessPersonAllowed(context) ? { ok: true, data: review(false) } : forbidden()),
      run: async (input, context) => {
        if (!codeAccessPersonAllowed(context)) return forbidden();
        const data = await setCodeAccess(appId, bindings, input, context);
        return {
          ok: true,
          data: {
            data,
            receipt: { text: data.granted ? (input.dryRun ? "Code access is available" : "Code access granted") : data.reason },
          },
        };
      },
    },
    "code.access.rm": {
      title: "Remove Code access",
      description: "Remove an explicit Code grant with current target manager authority.",
      input: CodeAccessRemoveInputSchema,
      data: CodeAccessRemoveDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      code: false,
      unattended: false,
      policy: { ask: "changes_access" },
      review: (_input, context) => (codeAccessPersonAllowed(context) ? { ok: true, data: review(true) } : forbidden()),
      run: async (input, context) => {
        if (!codeAccessPersonAllowed(context)) return forbidden();
        const removed = await removeCodeAccess(appId, bindings, input.grantId, { context });
        return {
          ok: true,
          data: { data: { removed }, receipt: { text: removed ? "Code access removed" : "Code access could not be removed" } },
        };
      },
    },
  };
  const queries: Record<string, CapabilityQueryDefinition> = {
    "code.access.list": {
      title: "List Code access",
      description: "List current explicit Code grants at targets this person manages.",
      input: CodeAccessListInputSchema,
      data: CodeAccessListDataSchema,
      openWorld: false,
      run: async (input, context) =>
        codeAccessPersonAllowed(context)
          ? { ok: true, data: { data: await listCodeAccess(appId, bindings, input.principal, context) } }
          : forbidden(),
    },
  };
  return { queries, actions };
};
