import { capabilityManifestEvolutionIssues, compileCapabilities } from "../_internal/capabilities";
import {
  type CapabilityReviewContext,
  type CapabilityReviewForms,
  capabilityActionReviewIssues,
  capabilityReviewFormIssues,
} from "../_internal/capability-reviews";
import { capabilitySentenceParts } from "../_internal/capability-sentences";
import {
  CapabilityActionCallReviewSchema,
  CapabilityActionReviewDataSchema,
  type CapabilityDefinitions,
  type CapabilityManifest,
  type CapabilityResult,
  CapabilitySemanticLinkSchema,
  type CapabilitySlot,
} from "../contracts/capabilities";

/** Compile and validate the public manifest an app would register at startup. */
export const compileCapabilityManifest = (
  appId: string,
  definitions: CapabilityDefinitions,
  routes?: readonly string[],
): CapabilityManifest => compileCapabilities(appId, definitions, routes).manifest;

/** Fail a provider compatibility test when a published local id changed incompatibly. */
export const assertCapabilityManifestEvolution = (previous: CapabilityManifest, next: CapabilityManifest): void => {
  const issues = capabilityManifestEvolutionIssues(previous, next);
  if (issues.length > 0) throw new Error(`Breaking Capability manifest evolution:\n- ${issues.join("\n- ")}`);
};

/** Assert that a reader result exposes a valid destination for its resource permalink. */
export const assertResourceOpenLink = (result: Pick<CapabilityResult<unknown>, "links">) => {
  const link = result.links?.find((link) => link.rel === "open");
  if (!link) throw new Error("Resource reader must return a top-level open link");
  return CapabilitySemanticLinkSchema.parse(link);
};

/** Validate each localized review in application tests, with optional declaration context. */
export const assertCapabilityReview = (review: unknown, context?: CapabilityReviewContext): void => {
  const parsed = CapabilityActionReviewDataSchema.safeParse(review);
  const issues = context
    ? capabilityActionReviewIssues(review, context)
    : !parsed.success
      ? parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      : "sentence" in parsed.data
        ? capabilityReviewFormIssues(parsed.data)
        : [];
  if (issues.length) throw new Error(`Invalid Capability review:\n- ${issues.join("\n- ")}`);
};

/** Catalog check: the 80-character question bound is guidance for app messages, not a runtime restriction. */
export const checkActionReviewMessages = (input: {
  locales: readonly string[];
  forms: (locale: string) => CapabilityReviewForms;
  slots: Readonly<Record<string, CapabilitySlot>>;
}): string[] =>
  input.locales.flatMap((locale) => {
    try {
      const review = CapabilityActionCallReviewSchema.safeParse({ ...input.forms(locale), slots: input.slots });
      if (!review.success) return review.error.issues.map((issue) => `${locale} ${issue.path.join(".")}: ${issue.message}`);
      const issues = capabilityReviewFormIssues(review.data).map((issue) => `${locale}: ${issue}`);
      const visible = capabilitySentenceParts(review.data.sentence.action, review.data.slots, {
        locale: review.data.locale,
        timeZone: "UTC",
      })
        .map((part) => (part.kind === "text" ? part.text : part.label))
        .join("");
      if (Array.from(`${visible}?`).length > 80) issues.push(`${locale}: question exceeds 80 visible characters`);
      return issues;
    } catch (error) {
      return [`${locale}: ${error instanceof Error ? error.message : String(error)}`];
    }
  });
