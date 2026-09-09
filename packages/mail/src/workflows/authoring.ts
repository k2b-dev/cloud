import {
  buildWorkflowManifestCompletions,
  type WorkflowCompletionItem,
  workflowCompletionContext,
  workflowCompletionItem,
} from "@k2b/cloud/workflows";
import type { MailWorkflowCatalog, MailWorkflowCatalogEntry, MailWorkflowCatalogIndex } from "./catalog";
import { mailWorkflows } from "./module";

const uniqueEntries = <T extends MailWorkflowCatalogEntry>(index: MailWorkflowCatalogIndex<T>): T[] =>
  [...new Map([...index.refs.values()].map((entry) => [entry.id, entry])).values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );

export const buildMailWorkflowCompletions = (source: string, caret: number, catalog: MailWorkflowCatalog): WorkflowCompletionItem[] => {
  const context = workflowCompletionContext(source, caret);
  const entries =
    context.key === "folder"
      ? uniqueEntries(catalog.folders)
      : context.key === "tag"
        ? uniqueEntries(catalog.localTags)
        : context.key === "sender"
          ? uniqueEntries(catalog.senderIdentities)
          : context.key === "user"
            ? [
                ...new Map(
                  [...uniqueEntries(catalog.assignableUsers), ...uniqueEntries(catalog.notificationUsers)].map((entry) => [
                    entry.id,
                    entry,
                  ]),
                ).values(),
              ]
            : null;
  if (entries) {
    return entries.map((entry) => workflowCompletionItem(context, "source", entry.name, JSON.stringify(entry.name), entry.id));
  }
  return buildWorkflowManifestCompletions(source, caret, mailWorkflows);
};
