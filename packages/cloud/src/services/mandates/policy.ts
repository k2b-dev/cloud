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

export const MandatePolicyV1Schema = z
  .object({
    version: z.literal(MANDATE_POLICY_VERSION),
    apps: z.union([z.literal("*"), identifierList(CapabilityAppIdSchema)]),
    operations: z.union([z.literal("*"), identifierList(operationSchema)]),
    actions: z.enum(["deny", "require_approval", "preapproved"]),
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
  ACTION_AUTHORITY[next.actions] <= ACTION_AUTHORITY[current.actions];

export const mandatePolicyAllows = (
  policy: MandatePolicyV1,
  input: { appId: string; operation: string; actionApproval: "none" | "approved" },
): boolean => {
  if (policy.apps !== "*" && !policy.apps.includes(input.appId)) return false;
  if (policy.operations !== "*" && !policy.operations.includes(input.operation)) return false;
  if (!input.operation.startsWith("capability.action.run:")) return true;
  if (policy.actions === "deny") return false;
  if (policy.actions === "require_approval") return input.actionApproval === "approved";
  return true;
};
