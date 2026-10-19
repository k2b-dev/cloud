import type { z } from "zod";
import { capabilityPreviewIssues, capabilityReviewFormIssues } from "../capabilities/reviews";
import {
  CAPABILITY_REACHES,
  CapabilityActionCheckSchema,
  type CapabilityActionPolicy,
  CapabilityActionReceiptSchema,
  CapabilityActionReviewDataSchema,
  type CapabilityQueryManifest,
  type CapabilitySemanticLink,
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
};
const schemaIssues = (error: z.ZodError): string[] => error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
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
    if (!query || capabilityHash(query.dataSchema) !== capabilityHash(projectSchema(CapabilityActionCheckSchema, "Action check", "output")))
      issues.push("check.query must return CapabilityActionCheckSchema");
    else if (!context.validateQueryInput(query, data.check.input)) issues.push("check.input does not match the Query");
  }
  issues.push(
    ...capabilityPreviewIssues(
      data.preview,
      data.links,
      (data.ask ?? ("ask" in context.policy ? context.policy.ask : undefined)) === "sends",
    ),
  );
  return [...new Set(issues)];
};
export const capabilityActionReceiptIssues = (
  receipt: unknown,
  context: CapabilityReviewContext & { links?: readonly CapabilitySemanticLink[] },
): string[] => {
  const parsed = CapabilityActionReceiptSchema.safeParse(receipt);
  return parsed.success ? capabilityPreviewIssues(parsed.data.preview, context.links) : schemaIssues(parsed.error);
};
