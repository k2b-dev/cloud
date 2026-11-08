import { z } from "zod";
import { ArtifactSource } from "../chat-code/contracts";

export { ArtifactFile, ArtifactPath, ArtifactSource, hasInterface, LIMITS } from "../chat-code/contracts";
/**
 * Public links to Studio apps, which let people without an account open a published app.
 * Off until apps run on a domain of their own: an anonymous visitor would otherwise see app
 * content, for example a convincing fake sign-in, on the Cloud domain. Set to true to turn
 * anonymous runner access and new public grants back on.
 */
export const PUBLIC_APP_SHARING = false;

export const ArtifactKind = z.literal("app");
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const ArtifactIcon = z
  .string()
  .regex(/^ti ti-[a-z0-9-]+$/)
  .max(80);
export const PublicationNote = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .describe("Concise user-facing explanation of this publication or rollback.");
export const ArtifactMetadata = z
  .object({
    title: z.string().trim().min(1).max(120).optional().describe("New working application title."),
    description: z.string().trim().max(500).optional().describe("New working application description."),
    icon: ArtifactIcon.optional().describe("Tabler icon class, for example ti ti-calculator."),
  })
  .strict();

export const ArtifactCreate = z
  .object({
    kind: ArtifactKind.default("app").describe(
      "Reusable App with optional GUI, actions and persistence. One-off code_run needs no resource.",
    ),
    title: z.string().trim().min(1).max(120).describe("Short user-facing app title."),
    description: z.string().trim().max(500).optional().describe("One or two sentences explaining what this app does."),
    icon: ArtifactIcon.optional().describe("Tabler icon class, for example ti ti-calculator."),
    source: ArtifactSource.describe("Initial source bundle. Creating an app does not execute it."),
  })
  .strict();
export const ArtifactUpdate = ArtifactCreate.omit({ kind: true }).extend({ expectedRevision: z.number().int().positive() });
export type ArtifactPermission = "use" | "manage";
