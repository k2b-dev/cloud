import type { z } from "zod";
import { validateBlocks } from "../blocks/validate";
import { boundReviewView, capabilityReviewFormIssues, reviewBindingData, reviewDraft } from "../capabilities/reviews";
import {
  CAPABILITY_REACHES,
  CapabilityActionCheckSchema,
  type CapabilityActionPolicy,
  CapabilityActionReceiptSchema,
  CapabilityActionReviewDataSchema,
  type CapabilityQueryManifest,
} from "../contracts/capabilities";
import { localeFallbackChain } from "../shared/locale";
import { capabilityHash, projectSchema } from "./capability-schemas";

export {
  actionReview,
  type CapabilityReviewForms,
  capabilityReviewFormIssues,
  capabilityReviewRememberScope,
  capabilityReviewView,
  type SlotNames,
} from "../capabilities/reviews";

export { CAPABILITY_MAX_REVIEW_BYTES } from "../contracts/capabilities";
export type CapabilityReviewContext = {
  policy?: CapabilityActionPolicy;
  approval?: "rememberable" | "none";
  queries: readonly CapabilityQueryManifest[];
  validateQueryInput: (query: CapabilityQueryManifest, input: Record<string, unknown>) => boolean;
  locales?: readonly string[];
  inputSchema?: { properties?: Record<string, unknown> };
  appId?: string;
  appPrefixes?: readonly string[];
};
const schemaIssues = (error: z.ZodError): string[] => error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
let actionCheckDataHash: string | undefined;
/** Whether a Query answers an Action's `check`: its data schema is exactly the projected `CapabilityActionCheckSchema`. */
export const capabilityQueryChecksActionOutcome = (query: CapabilityQueryManifest): boolean => {
  actionCheckDataHash ??= capabilityHash(projectSchema(CapabilityActionCheckSchema, "Action check", "output"));
  return capabilityHash(query.dataSchema) === actionCheckDataHash;
};

export const capabilityActionReviewIssues = (review: unknown, context: CapabilityReviewContext): string[] => {
  const parsed = CapabilityActionReviewDataSchema.safeParse(review);
  if (!parsed.success) return schemaIssues(parsed.error);
  const data = parsed.data;
  if (!("sentence" in data))
    return context.policy
      ? ["A policy Action must return a new review"]
      : data.approvalScope !== undefined && context.approval !== "rememberable"
        ? ["approvalScope requires rememberable approval"]
        : [];
  if (!context.policy) return ["An Action without policy must return a legacy review"];
  const issues = capabilityReviewFormIssues(data);
  if (
    data.reach !== undefined &&
    (!("silent" in context.policy) || CAPABILITY_REACHES.indexOf(data.reach) > CAPABILITY_REACHES.indexOf(context.policy.silent))
  )
    issues.push("reach exceeds the declared silent reach");
  if (context.locales && !localeFallbackChain(data.locale, data.locale).some((locale) => context.locales?.includes(locale)))
    issues.push("locale is not supported by the app");
  if (data.check) {
    const query = context.queries.find((query) => query.localId === data.check?.query);
    if (!query || !capabilityQueryChecksActionOutcome(query)) issues.push("check.query must return CapabilityActionCheckSchema");
    else if (!context.validateQueryInput(query, data.check.input)) issues.push("check.input does not match the Query");
  }
  try {
    const view = boundReviewView(data);
    if (view) {
      validateBlocks(view.blocks, "review", {
        appId: context.appId ?? "",
        appPrefixes: context.appPrefixes ?? [],
        envelope: { ...reviewBindingData(data), view },
      });
      const draft = reviewDraft(view.blocks);
      if (
        draft &&
        (!context.inputSchema?.properties || draft.fields.some((field) => !Object.hasOwn(context.inputSchema!.properties!, field.name)))
      )
        issues.push("Draft fields must name top-level Action input properties");
      if (draft && "ask" in context.policy && context.policy.ask === "sends" && data.ask !== "sends")
        issues.push(...capabilityReviewFormIssues({ ...data, ask: "sends" }));
    }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "Invalid review view");
  }
  return [...new Set(issues)];
};
/** A receipt's own rules; completeness links are the result envelope's top-level `links`. */
export const capabilityActionReceiptIssues = (receipt: unknown, _links: unknown): string[] => {
  const parsed = CapabilityActionReceiptSchema.safeParse(receipt);
  return parsed.success ? [] : schemaIssues(parsed.error);
};
