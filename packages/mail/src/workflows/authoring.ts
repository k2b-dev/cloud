import {
  buildWorkflowManifestCompletions,
  type WorkflowCompletionItem,
  workflowCompletionContext,
  workflowCompletionItem,
} from "@k2b/cloud/workflows";
import { parseWorkflowYaml, readWorkflowValuePath, resolveWorkflowValuePathDescriptor } from "@k2b/cloud/workflows/language";
import type { MailWorkflowCatalog, MailWorkflowCatalogEntry, MailWorkflowCatalogIndex } from "./catalog";
import { mailWorkflows } from "./module";
import { mailValueDescriptors } from "./value-descriptors";

const uniqueEntries = <T extends MailWorkflowCatalogEntry>(index: MailWorkflowCatalogIndex<T>): T[] =>
  [...new Map([...index.refs.values()].map((entry) => [entry.id, entry])).values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );

export const buildMailWorkflowCompletions = (source: string, caret: number, catalog: MailWorkflowCatalog): WorkflowCompletionItem[] => {
  const context = workflowCompletionContext(source, caret);
  const reference = /\binputs\.([A-Za-z_]\w*)\.([\w.]*)$/.exec(source.slice(0, caret));
  if (reference) {
    const [, name, path = ""] = reference;
    const headerEnd = source.search(/^(?:triggers|steps):/m);
    const header = parseWorkflowYaml(headerEnd < 0 ? source : source.slice(0, headerEnd));
    const inputKind = header.ok ? readWorkflowValuePath(header.parsed.value, ["inputs", name!, "type"]) : undefined;
    const type = mailWorkflows.manifest.inputs.find((input) => input.kind === inputKind)?.valueType;
    const descriptor = type ? mailValueDescriptors[type] : undefined;
    const segments = path.split(".");
    const prefix = segments.pop()!;
    const value = descriptor ? resolveWorkflowValuePathDescriptor(descriptor, segments) : null;
    if (value?.kind === "object") {
      return Object.entries(value.properties)
        .filter(([field]) => field.startsWith(prefix))
        .map(([field, info]) =>
          workflowCompletionItem({ range: { start: caret - prefix.length, end: caret } }, "field", field, field, info.type),
        );
    }
  }

  if (context.key === "folder") {
    // Same-named folders under different parents are ambiguous by name; show the path and insert the stable ID instead.
    return uniqueEntries(catalog.folders).map((folder) => {
      const reference = catalog.folders.ambiguous.has(folder.name) ? folder.id : folder.name;
      return workflowCompletionItem(context, "source", folder.path ?? folder.name, JSON.stringify(reference), folder.id);
    });
  }
  const entries =
    context.key === "tag"
      ? uniqueEntries(catalog.localTags)
      : context.key === "sender"
        ? uniqueEntries(catalog.senderIdentities)
        : context.key === "user"
          ? [
              ...new Map(
                [...uniqueEntries(catalog.assignableUsers), ...uniqueEntries(catalog.notificationUsers)].map((entry) => [entry.id, entry]),
              ).values(),
            ]
          : null;
  if (entries) {
    return entries.map((entry) => workflowCompletionItem(context, "source", entry.name, JSON.stringify(entry.name), entry.id));
  }
  return buildWorkflowManifestCompletions(source, caret, mailWorkflows);
};
