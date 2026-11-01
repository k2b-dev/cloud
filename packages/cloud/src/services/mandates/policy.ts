import { z } from "zod";
import {
  type CapabilityActionPolicy,
  CapabilityAppIdSchema,
  CapabilityLocalIdSchema,
  CloudResourceRefSchema,
  type NormalizedCapabilityCall,
} from "../../contracts/capabilities";

/** Core stores one mandate per immutable Code version, shared by all its entry points. */
export const CODE_VERSION_MANDATE_WORKLOAD_TYPE = "code.version" as const;

/** Durable binding consumed by Code activation and invocation. workloadId is the immutable version ID. */
export type CodeVersionMandateBinding = {
  ownerAppId: "core";
  workloadType: typeof CODE_VERSION_MANDATE_WORKLOAD_TYPE;
  workloadId: string;
};

export const MANDATE_POLICY_VERSION = 1 as const;
export const MANDATE_POLICY_MAX_IDENTIFIERS = 100;

const identifierList = <T extends z.ZodType<string>>(schema: T) =>
  z
    .array(schema)
    .max(MANDATE_POLICY_MAX_IDENTIFIERS)
    .transform((items) => [...new Set(items)].sort());

const operationSchema = z.union([
  z.literal("search.query"),
  z.literal("runtime.http"),
  z.literal("runtime.database"),
  z.literal("workflow.run"),
  z.string().refine((value) => {
    const [prefix, localId, extra] = value.split(":");
    return (
      extra === undefined &&
      (prefix === "capability.query" ||
        prefix === "capability.action.review" ||
        prefix === "capability.action.run" ||
        prefix === "widget.read") &&
      CapabilityLocalIdSchema.safeParse(localId).success
    );
  }, "Expected a canonical mandate operation"),
]);

export const CapabilityGrantSchema = z
  .object({
    appId: CapabilityAppIdSchema.describe("Exact discovered application ID."),
    capabilityId: CapabilityLocalIdSchema.describe("Exact local capability ID from discovery, without application prefix."),
    kind: z.enum(["query", "action"]).describe("Discovered capability kind."),
    target: CloudResourceRefSchema.nullable()
      .optional()
      .describe("Exact primary target, or null for an app-wide operation. Omitted only for operation-only grants."),
    refs: z
      .record(z.string(), CloudResourceRefSchema)
      .optional()
      .describe("Exact additional targets, keyed by the declared reference field."),
    fixedInput: z.record(z.string(), z.json()).default({}).describe("Exact top-level input values. Omitted fields remain unrestricted."),
  })
  .strict();
export const CapabilityGrantsSchema = z.array(CapabilityGrantSchema).max(MANDATE_POLICY_MAX_IDENTIFIERS / 2);
/**
 * One operation at one target, shared by Code versions and person-owned routines.
 * appId + capabilityId + kind identify the operation. target is a qualified resource
 * reference, or null for app-wide Actions; refs fixes the complete additional-target map.
 * Omission is operation-only authority, never a wildcard target for a bound Action.
 * fixedInput only restricts domain input; it never substitutes for target or refs.
 * Code queries use operation-only grants; person routines may bind queries to a target.
 */
export type CapabilityGrant = z.output<typeof CapabilityGrantSchema>;

const httpsUrl = z
  .string()
  .url()
  .max(2000)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  }, "Use HTTPS without credentials or fragment");
export const TaskGrantSchema = z.union([
  CapabilityGrantSchema,
  z
    .object({
      kind: z.literal("http").describe("Authorize scheduled Code Mode HTTP requests."),
      fixedInput: z
        .object({
          origin: httpsUrl
            .refine((value) => new URL(value).origin === value, "Use an exact origin without path")
            .optional()
            .describe("Exact HTTPS origin, without path, wildcard or trailing slash."),
          url: httpsUrl.optional().describe("Exact full URL, including query parameters."),
          method: z
            .enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
            .optional()
            .describe("Exact HTTP method; omit to permit every supported method."),
        })
        .strict()
        .default({})
        .describe("Fixed input values. Omitted fields are unrestricted; empty input permits every supported target and operation."),
    })
    .strict(),
  z
    .object({
      kind: z.literal("database").describe("Authorize scheduled Code Mode RSQL operations."),
      fixedInput: z
        .object({
          resourceId: z.string().min(1).max(80).optional().describe("Exact Studio app ID whose database may be used."),
          operation: z
            .enum([
              "connect",
              "status",
              "export",
              "clear",
              "reset",
              "tables.list",
              "tables.create",
              "tables.update",
              "tables.delete",
              "schema.get",
              "rows.list",
              "rows.get",
              "rows.insert",
              "rows.update",
              "rows.delete",
              "query",
            ])
            .optional()
            .describe("Exact database operation; connect needs its own grant when operation is fixed."),
          table: z
            .string()
            .min(1)
            .max(63)
            .optional()
            .describe("Exact table; applies to row and schema operations, not arbitrary SQL queries."),
        })
        .strict()
        .default({})
        .describe("Fixed input values. Omitted fields are unrestricted; empty input permits every supported target and operation."),
    })
    .strict(),
]);
export const TaskGrantsSchema = z.array(TaskGrantSchema).max(MANDATE_POLICY_MAX_IDENTIFIERS / 2);
export type TaskGrant = z.output<typeof TaskGrantSchema>;

const equalJson = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equalJson(v, b[i]));
  const ak = Object.keys(a),
    bk = Object.keys(b);
  return ak.length === bk.length && ak.every((key) => Object.hasOwn(b, key) && equalJson(Reflect.get(a, key), Reflect.get(b, key)));
};
export const capabilityGrantAllows = (
  grant: CapabilityGrant,
  input: {
    appId: string;
    capabilityId: string;
    kind: "query" | "action";
    input: unknown;
    call?: NormalizedCapabilityCall;
    codeAccount?: boolean;
  },
): boolean =>
  grant.appId === input.appId &&
  grant.capabilityId === input.capabilityId &&
  grant.kind === input.kind &&
  !(input.codeAccount && input.kind === "action" && !input.call) &&
  ((input.codeAccount && input.kind === "query") ||
    (!input.call
      ? grant.target === undefined && grant.refs === undefined
      : (grant.target === undefined
          ? input.call.target === null && (!input.codeAccount || input.kind !== "action")
          : equalJson(grant.target, input.call.target)) && equalJson(grant.refs ?? {}, input.call.refs))) &&
  Object.entries(grant.fixedInput).every(
    ([key, value]) =>
      input.input !== null &&
      typeof input.input === "object" &&
      Object.hasOwn(input.input, key) &&
      equalJson(value, Reflect.get(input.input, key)),
  );

export const MandatePolicyV1Schema = z
  .object({
    version: z.literal(MANDATE_POLICY_VERSION),
    apps: z.union([z.literal("*"), identifierList(CapabilityAppIdSchema)]),
    operations: z.union([z.literal("*"), identifierList(operationSchema)]),
    actions: z.enum(["deny", "require_approval", "preapproved"]),
    grants: TaskGrantsSchema.optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (
      policy.actions === "preapproved" &&
      (policy.apps === "*" || policy.operations === "*" || policy.apps.length === 0 || policy.operations.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message: "Preapproved actions require explicit non-empty app and operation allowlists",
      });
    }
    if ((policy.apps === "*" || policy.operations === "*") && policy.actions !== "require_approval") {
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message: "Wildcard mandates must require action approval",
      });
    }
  });

export type MandatePolicyV1 = z.output<typeof MandatePolicyV1Schema>;

export const parseMandatePolicy = (input: unknown): MandatePolicyV1 => MandatePolicyV1Schema.parse(input);

const setAllows = (current: "*" | string[], next: "*" | string[]): boolean => {
  if (current === "*") return true;
  if (next === "*") return false;
  const allowed = new Set(current);
  return next.every((value) => allowed.has(value));
};

const ACTION_AUTHORITY = { deny: 0, require_approval: 1, preapproved: 2 } as const;

/** True when `next` grants no authority that `current` did not already grant. */
export const isMandatePolicyNarrowing = (current: MandatePolicyV1, next: MandatePolicyV1): boolean =>
  setAllows(current.apps, next.apps) &&
  setAllows(current.operations, next.operations) &&
  ACTION_AUTHORITY[next.actions] <= ACTION_AUTHORITY[current.actions] &&
  (current.grants === undefined
    ? !next.grants?.some(
        (grant) =>
          grant.kind === "http" || grant.kind === "database" || grant.target !== undefined || Object.keys(grant.refs ?? {}).length > 0,
      )
    : next.grants !== undefined &&
      next.grants.every((grant) =>
        current.grants!.some((existing) => {
          if (existing.kind !== grant.kind) return false;
          if ("appId" in existing && "appId" in grant && (existing.appId !== grant.appId || existing.capabilityId !== grant.capabilityId))
            return false;
          if ("appId" in existing && "appId" in grant) {
            if (existing.target !== undefined && !equalJson(existing.target, grant.target)) return false;
            if (existing.refs !== undefined && !equalJson(existing.refs, grant.refs ?? {})) return false;
            // An operation-only grant did not authorize Code Actions, including app-wide Actions.
            if (existing.target === undefined && grant.target !== undefined) return false;
            if (existing.refs === undefined && Object.keys(grant.refs ?? {}).length) return false;
          }
          return Object.entries(existing.fixedInput).every(([key, value]) => equalJson(value, Reflect.get(grant.fixedInput, key)));
        }),
      ));

/**
 * True when a background mandate permits one operation. Unattended Actions must fit the live
 * capability policy whenever the mandate has grants or preapproves Actions; a `require_approval`
 * mandate without grants runs an Action only after its separate approval completed through Cloud.
 */
export const mandatePolicyAllows = (
  policy: MandatePolicyV1,
  input: {
    appId: string;
    operation: string;
    actionApproval: "none" | "approved";
    input?: unknown;
    /** Validated full call; required for target-bound authorization. */
    call?: NormalizedCapabilityCall;
    /** Derived from the live service-account row, never request JSON. */
    codeAccount?: boolean;
    /** Core-owned code.version workload; personal Code retains dynamic targets. */
    codeVersion?: boolean;
    capabilityPolicy?: CapabilityActionPolicy;
    capabilityApproval?: "none" | "rememberable" | "always";
  },
): boolean => {
  if (policy.apps !== "*" && !policy.apps.includes(input.appId)) return false;
  if (policy.operations !== "*" && !policy.operations.includes(input.operation)) return false;
  if (input.operation === "runtime.http" || input.operation === "runtime.database") {
    const kind = input.operation === "runtime.http" ? "http" : "database";
    return (
      input.appId === "assistant" &&
      !!policy.grants?.some(
        (grant) =>
          grant.kind === kind &&
          Object.entries(grant.fixedInput).every(
            ([key, value]) =>
              input.input !== null &&
              typeof input.input === "object" &&
              Object.hasOwn(input.input, key) &&
              equalJson(value, Reflect.get(input.input, key)),
          ),
      )
    );
  }
  const [operation, capabilityId] = input.operation.split(":");
  const kind =
    operation === "capability.query"
      ? "query"
      : operation === "capability.action.run" || operation === "capability.action.review"
        ? "action"
        : null;
  if (input.call && input.call.capability !== `${input.appId}.${capabilityId}`) return false;
  if (kind === "action" && input.codeAccount && policy.grants === undefined) return false;
  if (
    policy.grants === undefined &&
    input.call &&
    (input.call.target !== null || Object.keys(input.call.refs).length > 0) &&
    !input.codeVersion
  )
    return false;
  if (policy.grants !== undefined) {
    if (
      !kind ||
      !capabilityId ||
      !policy.grants.some(
        (grant) =>
          "appId" in grant &&
          capabilityGrantAllows(grant, {
            appId: input.appId,
            capabilityId,
            kind,
            input: input.input,
            call: input.call,
            codeAccount: input.codeAccount,
          }),
      )
    )
      return false;
  }
  // Routine grants and unattended preapproval must both fit the live capability policy.
  // A no-grants require_approval mandate keeps its separately approved execution path.
  if (kind === "action" && (policy.grants !== undefined || policy.actions === "preapproved")) {
    if (input.capabilityPolicy) {
      if (!("silent" in input.capabilityPolicy) || input.capabilityPolicy.routines === false) return false;
    } else if (input.capabilityApproval !== "none" && input.capabilityApproval !== "rememberable") return false;
  }
  if (!input.operation.startsWith("capability.action.run:")) return true;
  if (policy.actions === "deny") return false;
  if (policy.actions === "require_approval") return input.actionApproval === "approved";
  return true;
};

/** Discovery ignores fixed inputs: at least one unattended call must fit the policy. */
export const mandatePolicyCanPermitCapability = (
  policy: MandatePolicyV1,
  input: {
    appId: string;
    capabilityId: string;
    kind: "query" | "action";
    capabilityPolicy?: CapabilityActionPolicy;
    approval?: "none" | "rememberable" | "always";
  },
): boolean => {
  const call = {
    appId: input.appId,
    operation: `capability.${input.kind === "query" ? "query" : "action.run"}:${input.capabilityId}`,
    actionApproval: "none" as const,
    capabilityApproval: input.approval,
    capabilityPolicy: input.capabilityPolicy,
  };
  if (policy.grants === undefined) return mandatePolicyAllows(policy, call);
  return policy.grants.some(
    (grant) =>
      "appId" in grant &&
      mandatePolicyAllows(policy, {
        ...call,
        input: grant.fixedInput,
        ...(grant.target !== undefined || grant.refs !== undefined
          ? {
              call: {
                capability: `${grant.appId}.${grant.capabilityId}`,
                target: grant.target ?? null,
                refs: grant.refs ?? {},
                input: grant.fixedInput,
              },
            }
          : {}),
      }),
  );
};
