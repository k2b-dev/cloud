import { z } from "zod";
import { CapabilityAppIdSchema, CapabilityLocalIdSchema } from "../../contracts/capabilities";

export const MANDATE_POLICY_VERSION = 1 as const;
export const MANDATE_POLICY_MAX_IDENTIFIERS = 100;

const identifierList = <T extends z.ZodType<string>>(schema: T) =>
  z
    .array(schema)
    .max(MANDATE_POLICY_MAX_IDENTIFIERS)
    .transform((items) => [...new Set(items)].sort());

const operationSchema = z.union([
  z.literal("search.query"),
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
    fixedInput: z.record(z.string(), z.json()).default({}).describe("Exact top-level input values. Omitted fields remain unrestricted."),
  })
  .strict();
export const CapabilityGrantsSchema = z.array(CapabilityGrantSchema).max(MANDATE_POLICY_MAX_IDENTIFIERS / 2);
export type CapabilityGrant = z.output<typeof CapabilityGrantSchema>;

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
  input: { appId: string; capabilityId: string; kind: "query" | "action"; input: unknown },
): boolean =>
  grant.appId === input.appId &&
  grant.capabilityId === input.capabilityId &&
  grant.kind === input.kind &&
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
    grants: CapabilityGrantsSchema.optional(),
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
  (current.grants === undefined ||
    (next.grants !== undefined &&
      next.grants.every((grant) =>
        current.grants!.some((existing) => capabilityGrantAllows(existing, { ...grant, input: grant.fixedInput })),
      )));

export const mandatePolicyAllows = (
  policy: MandatePolicyV1,
  input: {
    appId: string;
    operation: string;
    actionApproval: "none" | "approved";
    input?: unknown;
    capabilityApproval?: "none" | "rememberable" | "always";
  },
): boolean => {
  if (policy.apps !== "*" && !policy.apps.includes(input.appId)) return false;
  if (policy.operations !== "*" && !policy.operations.includes(input.operation)) return false;
  if (policy.grants !== undefined) {
    const [operation, capabilityId] = input.operation.split(":");
    const kind =
      operation === "capability.query"
        ? "query"
        : operation === "capability.action.run" || operation === "capability.action.review"
          ? "action"
          : null;
    if (
      !kind ||
      !capabilityId ||
      !policy.grants.some((grant) => capabilityGrantAllows(grant, { appId: input.appId, capabilityId, kind, input: input.input }))
    )
      return false;
    if (kind === "action" && input.capabilityApproval !== "none" && input.capabilityApproval !== "rememberable") return false;
  }
  if (!input.operation.startsWith("capability.action.run:")) return true;
  if (policy.actions === "deny") return false;
  if (policy.actions === "require_approval") return input.actionApproval === "approved";
  return true;
};
