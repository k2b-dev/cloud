import { invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities";
import { type CodeVersionReadModel, CodeVersionReadModelSchema } from "@k2b/cloud/contracts/code-read-model";
import { codeOwnPath } from "@k2b/cloud/contracts/code-routes";
import { z } from "zod";

/** A target or event place, named as the Code page names it. */
const TargetSchema = z.object({
  key: z.string(),
  ref: z.object({ type: z.string(), id: z.string() }),
  title: z.string().nullable(),
  typeTitle: z.string().nullable(),
  icon: z.string().nullable(),
  own: z.boolean(),
  href: z.string().nullable(),
});
/** What switching on one version would do for this person, from Core's activation preview. */
const PreviewSchema = z.object({
  codeId: z.string(),
  title: z.string(),
  ownerKind: z.enum(["person", "resource", "app"]),
  /** For Code of an app: the app's name, which names its service account. */
  appName: z.string().nullable().optional(),
  automations: z
    .array(
      z.object({
        entrypoint: z.string(),
        title: z.string().optional(),
        route: z.object({ method: z.string(), path: z.string(), public: z.boolean() }).optional(),
        event: z.object({ type: z.string(), title: z.string().nullable(), place: TargetSchema }).optional(),
        /** When a schedule runs: its repeating expression, or a one-time instant and the zone it is read in. */
        cron: z.string().optional(),
        at: z.string().optional(),
        timeZone: z.string().optional(),
      }),
    )
    .optional(),
  /** What else the version may do: internet origins, the secrets it sends to them and its own database. */
  internet: z.array(z.string()).optional(),
  secrets: z.array(z.object({ name: z.string(), origin: z.string() })).optional(),
  database: z.boolean().optional(),
  versionId: z.string(),
  number: z.number().int(),
  running: z.number().int().nullable(),
  latest: z.number().int(),
  activated: z.object({ at: z.string(), byYou: z.boolean(), byName: z.string().nullable() }).nullable(),
  allowed: z.union([
    z.object({ allowed: z.literal(true) }),
    z.object({ allowed: z.literal(false), reason: z.enum(["phone", "credential"]) }),
  ]),
  /** What Core saw at submission: the check passed, and the version's test cases ran with this result. */
  tests: z
    .object({ state: z.enum(["passed", "failed", "none", "unavailable"]), passed: z.number().int(), total: z.number().int() })
    .optional(),
  readiness: z.union([
    z.object({ state: z.enum(["ready", "approval_pending"]) }),
    z.object({ state: z.literal("refused"), code: z.string(), message: z.string() }),
  ]),
  place: z.object({ title: z.string(), typeTitle: z.string().nullable(), href: z.string().nullable() }).nullable(),
  /** The Code page of a resource Code, as its owner's app declares it in the registry. */
  page: z.string().nullable().optional(),
  operationLabels: z.record(z.string(), z.object({ title: z.string(), app: z.string().nullable() })).optional(),
  /** What switching on this version calls where, as the Code page lists it; a null target is picked while the Code runs. */
  targets: z
    .array(
      z.object({
        target: TargetSchema.nullable(),
        operations: z.array(z.string()),
        isNew: z.boolean(),
      }),
    )
    .optional(),
});
export type CodeVersionPreview = z.infer<typeof PreviewSchema>;

/** The Code page of this Code: a personal Code's page in Gustav, or the Code page its owner's app declares. */
export const codeVersionPageHref = (preview: CodeVersionPreview): string | null =>
  preview.ownerKind === "person" ? `/app/assistant/code/${preview.codeId}` : (preview.page ?? null);

/** The Code's own page: its first route a browser can open (GET or ALL) without named segments, served under `/code/<id>`. */
export const codeVersionOwnPageHref = (preview: CodeVersionPreview): string | null => {
  const route = preview.automations?.find(
    (entry) => (entry.route?.method === "GET" || entry.route?.method === "ALL") && !entry.route.path.includes(":"),
  )?.route;
  return route ? codeOwnPath(preview.codeId, route.path) : null;
};

const StatusSchema = z.object({
  state: z.enum(["pending", "preflight", "applying", "waiting", "rolling_back", "failed", "active", "cancelled"]),
  failure: z.object({ reason: z.string() }).nullable(),
});
export type CodeVersionActivation = z.infer<typeof StatusSchema>;

/** Core's activation routes take only the person's own browser session. */
const post = async (route: string, body: unknown) =>
  fetch(`/api/code/${route}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });

/** `denied`: Core will not show this version to this person. Any other failure can be tried again. */
export const loadCodeVersionPreview = async (codeId: string, versionId: string): Promise<CodeVersionPreview | "denied" | "failed"> => {
  try {
    const response = await post("activation/preview", { codeId, versionId });
    if (response.status === 403 || response.status === 404) return "denied";
    if (!response.ok) return "failed";
    const parsed = z.object({ data: PreviewSchema }).safeParse(await response.json());
    return parsed.success ? parsed.data.data : "failed";
  } catch {
    return "failed";
  }
};

/**
 * `definite`: Core answered with a refusal, so it did not act; `notFound`: no such activation. Otherwise the outcome is
 * unknown, and only Core's status can say what happened.
 */
export type CodeVersionActivationAnswer =
  | { ok: true; status: CodeVersionActivation }
  | { ok: false; message: string | null; definite: boolean; notFound: boolean };

const answer = async (route: "activate" | "activation/read", body: unknown): Promise<CodeVersionActivationAnswer> => {
  try {
    const response = await post(route, body);
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = z.object({ message: z.string() }).safeParse(json).data?.message ?? null;
      return { ok: false, message, definite: response.status >= 400 && response.status < 500, notFound: response.status === 404 };
    }
    const parsed = z.object({ data: StatusSchema }).safeParse(json);
    return parsed.success ? { ok: true, status: parsed.data.data } : { ok: false, message: null, definite: false, notFound: false };
  } catch {
    return { ok: false, message: null, definite: false, notFound: false };
  }
};
export const startCodeVersionActivation = (codeId: string, versionId: string, activationId: string) =>
  answer("activate", { codeId, versionId, activationId });
export const readCodeVersionActivation = (codeId: string, activationId: string) => answer("activation/read", { codeId, activationId });

/**
 * An activation whose outcome is unknown survives a reload in this tab, so asking again resumes it instead of starting
 * a second one. The key is the Code page's: both surfaces continue the same attempt.
 */
export const pendingCodeVersionActivation = (codeId: string, versionId: string) => {
  const key = `cloud.code.activation:${codeId}:${versionId}`;
  return {
    read: (): string | null => {
      try {
        return sessionStorage.getItem(key);
      } catch {
        return null;
      }
    },
    write: (id: string | null) => {
      try {
        if (id) sessionStorage.setItem(key, id);
        else sessionStorage.removeItem(key);
      } catch {
        // Without storage the identity lives as long as the card.
      }
    },
  };
};

/** The review as the person who manages the Code sees it: comments as text, never their place in the source. */
const ReviewSchema = z.object({
  status: z.enum(["not_required", "pending", "approved", "changes_requested", "rejected", "withdrawn", "superseded", "expired"]),
  origin: z.union([
    z.object({ kind: z.literal("cli") }),
    z.object({ kind: z.literal("ai_chat"), conversationId: z.string(), automaticAfterReview: z.boolean() }),
  ]),
  decidedBy: z.object({ id: z.string().nullable(), name: z.string().nullable(), avatarHash: z.string().nullable() }).nullable(),
  decidedAt: z.string().nullable(),
  message: z.string().nullable(),
  comments: z.array(
    z.object({
      id: z.string(),
      author: z.object({ id: z.string().nullable(), name: z.string().nullable(), avatarHash: z.string().nullable() }),
      createdAt: z.string(),
      body: z.string(),
      parentId: z.string().nullable(),
    }),
  ),
  commentCount: z.number().int(),
  activeVersion: z.object({ id: z.string(), number: z.number().int() }).nullable(),
  /** Gustav's one automatic revision after requested changes, as Core tracks it. */
  revision: z
    .object({
      state: z.enum(["none", "queued", "running", "submitted", "completed", "stopped", "skipped"]),
      reason: z
        .enum(["already_automatic", "superseded", "withdrawn", "conversation_gone", "access_lost", "quota", "unavailable", "stopped", "needs_person"])
        .nullable(),
      submittedNumber: z.number().int().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type CodeVersionReview = z.infer<typeof ReviewSchema>;

/** `null`: Core could not say; the card then follows the activation preview alone. */
export const loadCodeVersionReview = async (codeId: string, versionId: string): Promise<CodeVersionReview | null> => {
  try {
    const response = await post("review", { codeId, versionId });
    if (!response.ok) return null;
    const parsed = z.object({ data: ReviewSchema }).safeParse(await response.json());
    return parsed.success ? parsed.data.data : null;
  } catch {
    return null;
  }
};

/** True when Core withdrew the waiting version; any other answer changed nothing that the card can claim. */
export const withdrawCodeVersion = async (codeId: string, versionId: string): Promise<boolean> => {
  try {
    return (await post("withdraw", { codeId, versionId })).ok;
  } catch {
    return false;
  }
};

/** The version in words, from Core's read model: what changes against the version before, and the tried examples. */
export const loadCodeVersionWords = async (codeId: string, versionId: string): Promise<CodeVersionReadModel | null> => {
  const result = await invokeCapabilityWithDataSchema(
    { appId: "core", capabilityId: "code.version.words", kind: "query", input: { codeId, versionId } },
    CodeVersionReadModelSchema,
  ).catch(() => null);
  return result?.ok ? result.data.data : null;
};

/**
 * Stops Gustav's automatic revision. `too_late`: Gustav had already submitted the new version, which the person can
 * withdraw; `null`: Core did not answer, so nothing is claimed.
 */
export const stopCodeReviewRevision = async (
  codeId: string,
  versionId: string,
): Promise<{ status: "stopped" } | { status: "too_late"; submittedNumber: number | null } | null> => {
  try {
    const response = await post("authoring/reviewStop", { codeId, versionId });
    if (!response.ok) return null;
    const parsed = z
      .object({ status: z.enum(["stopped", "too_late"]), submittedNumber: z.number().int().nullable() })
      .safeParse(await response.json());
    if (!parsed.success) return null;
    return parsed.data.status === "too_late" ? { status: "too_late", submittedNumber: parsed.data.submittedNumber } : { status: "stopped" };
  } catch {
    return null;
  }
};

/** Asks the admins again after the request expired: Core submits the saved project as a new version with its own request. */
export const requestCodeVersionAgain = async (codeId: string, versionId: string): Promise<{ id: string; number: number } | null> => {
  try {
    const response = await post("authoring/reviewRequestAgain", { codeId, versionId });
    if (!response.ok) return null;
    const parsed = z.object({ version: z.object({ id: z.string(), number: z.number().int() }) }).safeParse(await response.json());
    return parsed.success ? { id: parsed.data.version.id, number: parsed.data.version.number } : null;
  } catch {
    return null;
  }
};
