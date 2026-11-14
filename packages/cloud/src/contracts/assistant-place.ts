import { z } from "zod";
import type { CapabilityManifest } from "./capabilities";
import { type CapabilityContractIssue, capabilityContractIssues } from "./capability-compatibility";

/** Provider data is untrusted content; the executor supplies its own instructions. */
export const ASSISTANT_PLACE_CONTEXT_MAX_BYTES = 32 * 1024;
export const AssistantPlaceSchema = z
  .object({
    title: z.string().min(1).max(200),
    context: z
      .string()
      .max(ASSISTANT_PLACE_CONTEXT_MAX_BYTES)
      .refine((text) => new TextEncoder().encode(text).byteLength <= ASSISTANT_PLACE_CONTEXT_MAX_BYTES, "Context exceeds 32 KiB of UTF-8"),
    tools: z.array(z.string()).max(16),
    skills: z.array(z.string()).max(8),
    starters: z
      .array(z.object({ label: z.string().max(80), prompt: z.string().max(500) }).strict())
      .max(3)
      .optional(),
  })
  .strict();
export type AssistantPlace = z.infer<typeof AssistantPlaceSchema>;
export type AssistantPlaceResult = AssistantPlace | { unavailable: true; retry?: true };

/** Validate a Type's provider and declared tool superset at startup and when consuming a live manifest. */
export const assistantPlaceIssues = (manifest: CapabilityManifest, localType?: string): CapabilityContractIssue[] => {
  const issues: CapabilityContractIssue[] = [];
  for (const type of manifest.types) {
    if (!type.assistant || (localType !== undefined && localType !== type.localId)) continue;
    const path = `$.types.${type.localId}.assistant`;
    const add = (message: string) => issues.push({ code: "kind", path, message });
    if (!type.reader || !manifest.queries.some((query) => query.localId === type.reader)) add("Assistant place requires a reader");
    const provider = manifest.queries.find((query) => query.localId === type.assistant!.provider);
    if (!provider) add("Assistant provider must be a same-app Query");
    else {
      issues.push(
        ...capabilityContractIssues(
          { kind: "query", target: type.localId, input: z.object({}).strict(), data: AssistantPlaceSchema },
          { kind: "query", operation: provider },
        ).map((issue) => ({ ...issue, path: `${path}.provider${issue.path.slice(1)}` })),
      );
      if (provider.appOnly || provider.openWorld || Object.keys(provider.refs ?? {}).length)
        add("Assistant provider must be closed-world, person-readable, and need only its target");
    }
    for (const id of type.assistant.tools) {
      const action = manifest.actions.find((action) => action.localId === id);
      if (!action || action.target !== type.localId || action.destructive || action.openWorld)
        add(`Assistant tool ${id} must be a same-app, closed-world, non-destructive Action targeting ${type.localId}`);
    }
  }
  return issues;
};

/** Skill names can belong to any application. Existence does not grant runtime access. */
export const assertAssistantPlaceSkills = (manifest: CapabilityManifest, names: ReadonlySet<string>): void => {
  for (const type of manifest.types)
    for (const name of type.assistant?.skills ?? [])
      if (!names.has(name)) throw new Error(`Resource type ${type.localId}: assistant Skill ${name} does not exist`);
};
