import { z } from "zod";
import { resolveCapabilityManifestPresentation } from "../_internal/capabilities";
import { listCapabilities } from "../_internal/registry";
import { type CapabilityDispatchParams, dispatchCapability, QUERY_TIMEOUT_MS } from "../api/capabilities";
import {
  CloudResourceRefSchema,
  capabilityResultSchema,
  cloudResourceRefAppId,
  LinkedCloudResourceReferenceSchema,
  resolveCapabilityResourceReader,
} from "../contracts/capabilities";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import type { RequestAuthority } from "../server";
import { resolveAppIdentityPresentation } from "../shared/app-presentation";
import { LOCALE_HEADER } from "../shared/locale";
import { CODE_SOURCE_TOOLS } from "./code-source-contracts";
import { createCodeSourceTool } from "./code-source-tools";
import { RECENT_SENT_REF_LIMIT } from "./recent-sent-refs";
import { addCloudResourceHrefs } from "./resource-refs";
import { aiSkills } from "./skills";
import { aiConversations } from "./store";
import type { AiConversationService, AiRecentResource } from "./types";

export const AiRecentResourceSchema: z.ZodType<AiRecentResource> = z
  .object({
    ref: CloudResourceRefSchema,
    title: LinkedCloudResourceReferenceSchema.shape.title.unwrap(),
    icon: LinkedCloudResourceReferenceSchema.shape.icon,
    href: LinkedCloudResourceReferenceSchema.shape.href,
    kind: z.string().min(1).max(120),
    preview: z.string().max(160).optional(),
    appName: z.string().min(1).max(120),
    count: z.number().int().positive(),
  })
  .strict();

const ReaderResult = capabilityResultSchema(z.unknown(), { consumer: true });
const StudioData = z.object({
  id: z.string(),
  title: LinkedCloudResourceReferenceSchema.shape.title.unwrap(),
  icon: LinkedCloudResourceReferenceSchema.shape.icon,
  description: z.string().optional(),
});
const studioReader = async (input: {
  id: string;
  conversationId: string;
  authority: RequestAuthority;
  locale: string;
  signal: AbortSignal;
}): Promise<unknown> => {
  const tool = createCodeSourceTool("code_read");
  if (tool.location !== "server") throw new Error("Studio reader must run on the server.");
  return tool.run(CODE_SOURCE_TOOLS.code_read.input.parse({ id: input.id }), {
    actor: input.authority.actor,
    conversationId: input.conversationId,
    locale: input.locale,
    signal: input.signal,
    requestApproval: async () => false,
    requestClientTool: async () => {
      throw new Error("Recent resources cannot call client tools.");
    },
  });
};

export type AiRecentResourceDependencies = {
  store?: Pick<AiConversationService, "listRecentSentResourceRefs">;
  listRegistry?: () => Promise<CapabilityRegistryEntry[]>;
  dispatch?: (params: CapabilityDispatchParams) => Promise<Response>;
  skills?: Pick<typeof aiSkills, "list">;
  studioReader?: typeof studioReader;
  timeoutMs?: number;
};

const german = (locale: string) => locale.toLowerCase().split("-")[0] === "de";
/** Skills and Studio apps belong to the Assistant, which has no capability presentation to read its name from. */
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

/** Enforce the shared budget even when a dependency ignores cancellation. */
const withinBudget = async <T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> => {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([run(), aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

export const listAiRecentResources = async (input: {
  ownerUserId: string;
  authority: RequestAuthority;
  locale: string;
  signal: AbortSignal;
  dependencies?: AiRecentResourceDependencies;
}): Promise<AiRecentResource[]> => {
  const deps = input.dependencies ?? {};
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(deps.timeoutMs ?? QUERY_TIMEOUT_MS)]);
  // Unreadable history is no answer, not an empty one: the request fails, so the browser asks again at its next opening.
  const sent = await withinBudget(signal, () =>
    (deps.store ?? aiConversations).listRecentSentResourceRefs({ ownerUserId: input.ownerUserId }),
  );
  if (!sent.length || signal.aborted) return [];
  const candidates = sent.slice(0, RECENT_SENT_REF_LIMIT);
  const skillIds = candidates.flatMap(({ ref }) => (ref.type === "core.ai.skill" ? [ref.id] : []));
  // Exactly the sent Skills, so a large Skill catalog never pushes one out; failing, they are left out like a reader.
  const skills = skillIds.length
    ? withinBudget(signal, () => (deps.skills ?? aiSkills).list(input.authority.accessSubject, { shortIds: skillIds })).catch(() => [])
    : Promise.resolve([]);
  const registry = candidates.some(({ ref }) => ref.type !== "core.ai.skill" && ref.type !== "assistant.artifact")
    ? withinBudget(signal, deps.listRegistry ?? listCapabilities).catch(() => [])
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
        if (ref.type === "assistant.artifact") {
          const { actor, accessSubject, credentialKind, scopes } = input.authority;
          // code_read reconstructs a user session authority. Only use it when that is
          // exactly this request's authority; never widen scoped/delegated credentials.
          if (
            credentialKind !== "session" ||
            scopes.length ||
            actor.kind !== "user" ||
            actor.delegation ||
            actor.sessionKind === "app" ||
            accessSubject.type !== "user" ||
            accessSubject.userId !== actor.user.id
          )
            return null;
          const answer = ReaderResult.parse(
            await withinBudget(signal, () =>
              (deps.studioReader ?? studioReader)({
                id: ref.id,
                conversationId: candidate.conversationId,
                authority: input.authority,
                locale: input.locale,
                signal,
              }),
            ),
          );
          signal.throwIfAborted();
          const data = StudioData.parse(answer.data);
          if (data.id !== ref.id || !data.title.trim()) return null;
          const matched = answer.refs?.find((entry) => entry.type === ref.type && entry.id === ref.id);
          const ownRef = matched ? LinkedCloudResourceReferenceSchema.parse(matched) : undefined;
          const href = ownRef?.href ?? answer.links?.find((link) => link.rel === "open")?.href;
          return {
            ref,
            count,
            title: data.title,
            icon: ownRef?.icon ?? data.icon,
            href,
            preview: recentResourcePreview(ownRef?.preview ?? data.description),
            kind: german(input.locale) ? "Studio-App" : "Studio app",
            appName: assistantName(input.locale),
          };
        }
        const apps = await registry;
        signal.throwIfAborted();
        const appId = cloudResourceRefAppId(ref);
        const app = apps.find((app) => app.appId === appId);
        const reader = app && resolveCapabilityResourceReader(app.manifest, ref);
        if (!app || !reader) return null;
        const response = await withinBudget(signal, () =>
          (deps.dispatch ?? dispatchCapability)({
            request: new Request("http://localhost/api/ai/resources/recent", {
              method: "POST",
              headers: { [LOCALE_HEADER]: input.locale, "x-request-id": crypto.randomUUID() },
              signal,
            }),
            kind: "queries",
            origin: "assistant",
            appId: app.appId,
            capabilityId: reader.localId,
            input: { id: ref.id },
            authority: input.authority,
            locale: input.locale,
          }),
        );
        if (!response.ok) return null;
        const answer = ReaderResult.parse(addCloudResourceHrefs(await withinBudget(signal, () => response.json()), apps));
        const matched = answer.refs?.find((entry) => entry.type === ref.type && entry.id === ref.id);
        const ownRef = matched ? LinkedCloudResourceReferenceSchema.parse(matched) : undefined;
        if (!ownRef?.title?.trim()) return null;
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
