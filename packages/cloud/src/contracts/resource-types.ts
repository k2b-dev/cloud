import { z } from "zod";
import { type CapabilityManifest, CloudResourceReaderViewSchema } from "./capabilities";
import { type CapabilityContractIssue, capabilityContractIssues } from "./capability-compatibility";

/** Check the reader's guaranteed `data.view`; the type model supplies containment. */
export const typeViewIssues = (
  manifest: Pick<CapabilityManifest, "types" | "queries" | "resourceTypes">,
  localId: string,
): CapabilityContractIssue[] => {
  const type = manifest.types.find((type) => type.localId === localId);
  const reader = manifest.queries.find((query) => query.localId === type?.reader);
  if (!type || !reader) return [{ code: "kind", path: "$", message: `Type ${localId} needs a reader` }];
  const container = manifest.resourceTypes?.find((model) => model.type === localId)?.container;
  const view = container ? CloudResourceReaderViewSchema.required({ container: true }) : CloudResourceReaderViewSchema;
  const issues = capabilityContractIssues(
    { kind: "query", input: z.object({}).strict(), data: z.looseObject({ view }) },
    { kind: "query", operation: reader },
  ).filter((issue) => issue.code !== "input");
  if (reader.appOnly) issues.push({ code: "kind", path: "$", message: "A resource reader must accept person authority" });
  return issues;
};
