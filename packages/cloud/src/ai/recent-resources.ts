import { z } from "zod";
import { resolveCapabilityManifestPresentation } from "../_internal/capabilities";
import { CAPABILITY_DISCOVERY_TIMEOUT_MS } from "../_internal/capability-timeout";
import { CloudResourceRefSchema, LinkedCloudResourceReferenceSchema } from "../contracts/capabilities";
import type { RequestAuthority } from "../server";
import { resolveAppIdentityPresentation } from "../shared/app-presentation";
import { RECENT_SENT_REF_LIMIT } from "./recent-sent-refs";
import { type AiResourceReaderDependencies, readAiResource, readableApps, withinBudget } from "./resource-readers";
import { aiSkills } from "./skills";
import { aiConversations } from "./store";
import type { AiConversationService, AiRecentResource } from "./types";

export const AiRecentResourceSchema: z.ZodType<AiRecentResource> = z
  .object({
    ref: CloudResourceRefSchema,
    context: LinkedCloudResourceReferenceSchema.shape.context,
    status: LinkedCloudResourceReferenceSchema.shape.status,
    title: LinkedCloudResourceReferenceSchema.shape.title.unwrap(),
    icon: LinkedCloudResourceReferenceSchema.shape.icon,
    href: LinkedCloudResourceReferenceSchema.shape.href,
    kind: z.string().min(1).max(120),
    preview: z.string().max(160).optional(),
    appName: z.string().min(1).max(120),
    count: z.number().int().positive(),
  })
  .strict();

export type AiRecentResourceDependencies = AiResourceReaderDependencies & {
  store?: Pick<AiConversationService, "listRecentSentResourceRefs">;
  skills?: Pick<typeof aiSkills, "list">;
  timeoutMs?: number;
};

const german = (locale: string) => locale.toLowerCase().split("-")[0] === "de";
/** Skills belong to the Assistant, which has no capability presentation to read its name from. */
const assistantName = (locale: string) => (german(locale) ? "Assistent" : "Assistant");

/** First line only; reserve one character for the ellipsis and avoid splitting words. */
export const recentResourcePreview = (value: string | undefined): string | undefined => {
  const line = value?.split(/\r\n?|\n/, 1)[0]?.trim();
  if (!line) return undefined;
  if (line.length <= 160) return line;
  const clipped = line.slice(0, 159);
  const boundary = clipped.search(/\s+\S*$/);
  return `${(boundary > 0 ? clipped.slice(0, boundary) : clipped).trimEnd()}…`;
};

export const listAiRecentResources = async (input: {
  ownerUserId: string;
  authority: RequestAuthority;
  locale: string;
  signal: AbortSignal;
  dependencies?: AiRecentResourceDependencies;
}): Promise<AiRecentResource[]> => {
  const deps = input.dependencies ?? {};
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(deps.timeoutMs ?? CAPABILITY_DISCOVERY_TIMEOUT_MS)]);
  // Unreadable history is no answer, not an empty one: the request fails, so the browser asks again at its next opening.
  const sent = await withinBudget(signal, () =>
    (deps.store ?? aiConversations).listRecentSentResourceRefs({ ownerUserId: input.ownerUserId }),
  );
  if (!sent.length || signal.aborted) return [];
  const candidates = sent.slice(0, RECENT_SENT_REF_LIMIT);
  const skillIds = candidates.flatMap(({ ref }) => (ref.type === "core.ai.skill" ? [ref.id] : []));
  // Exactly the sent Skills, so a large Skill catalog never pushes one out; failing, they are left out like a reader.
  const skills = skillIds.length
    ? withinBudget(signal, () => (deps.skills ?? aiSkills).list(input.authority, { shortIds: skillIds, authority: input.authority })).catch(
        () => [],
      )
    : Promise.resolve([]);
  const registry = candidates.some(
    ({ ref }) => ref.type !== "core.ai.skill" && ref.type !== "assistant.artifact" && ref.type !== "assistant.app",
  )
    ? readableApps({ authority: input.authority, signal, dependencies: deps })
    : Promise.resolve([]);
  const resources = await Promise.all(
    candidates.map(async (candidate): Promise<AiRecentResource | null> => {
      try {
        signal.throwIfAborted();
        const { ref, count } = candidate;
        if (ref.type === "core.ai.skill") {
          const skill = (await skills).find((skill) => skill.shortId === ref.id && skill.enabled !== false);
          if (!skill) return null;
          return {
            ref,
            count,
            title: skill.name.slice(0, 500),
            icon: "ti ti-sparkles",
            kind: "Skill",
            preview: recentResourcePreview(skill.description),
            appName: assistantName(input.locale),
          };
        }
        if (ref.type === "assistant.artifact" || ref.type === "assistant.app") return null;
        const apps = await registry;
        const reading = await readAiResource({
          ref,
          apps,
          authority: input.authority,
          locale: input.locale,
          signal,
          path: "/api/ai/resources/recent",
          dependencies: deps,
        });
        if (!reading) return null;
        const { app, ref: ownRef } = reading;
        signal.throwIfAborted();
        const manifest = resolveCapabilityManifestPresentation(app.manifest, app.presentation, input.locale);
        const type = manifest.types.find((type) => `${app.appId}.${type.localId}` === ref.type);
        if (!type) return null;
        const presentation = resolveAppIdentityPresentation(
          { name: app.appName, description: app.appDescription, presentation: app.appPresentation },
          input.locale,
        );
        return {
          ref,
          count,
          title: ownRef.title,
          context: ownRef.context,
          status: ownRef.status,
          icon: (ownRef.icon ?? type.icon ?? app.appIcon)?.slice(0, 120),
          href: ownRef.href,
          kind: type.title.slice(0, 120),
          preview: recentResourcePreview(ownRef.preview),
          appName: presentation.name.slice(0, 120),
        };
      } catch {
        return null;
      }
    }),
  );
  return resources.flatMap((resource) => {
    const parsed = AiRecentResourceSchema.safeParse(resource);
    return parsed.success ? [parsed.data] : [];
  });
};
