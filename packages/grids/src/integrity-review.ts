import { actionReview } from "@k2b/cloud/capabilities";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";

/** Complete proposal content accompanies the compact localized action wording. */
export const gridsActionReview = (
  context: Pick<CapabilityExecutionContext, "locale">,
  title: string,
  proposal: unknown,
  scope?: string,
) => {
  const de = context.locale?.startsWith("de");
  const body = JSON.stringify(proposal, null, 2);
  title = title.slice(0, 200);
  return actionReview(
    {
      locale: context.locale ?? "en",
      sentence: {
        action: "{operation}",
        running: de ? "Wird ausgeführt: {operation}" : "Running: {operation}",
        done: de ? "Ausgeführt: {operation}" : "Completed: {operation}",
        confirm: de ? "Bestätigen" : "Confirm",
        decline: de ? "Abbrechen" : "Cancel",
      },
    },
    { operation: { kind: "object", title } },
    {
      ...(scope ? { scope } : {}),
      content: { kind: "page", title, body, format: "plain" },
      preview: { kind: "page", title, body: body.slice(0, 10000), format: "plain", truncated: body.length > 10000 },
    },
  );
};
