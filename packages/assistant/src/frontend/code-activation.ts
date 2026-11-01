import { z } from "zod";

/** What switching on one version would do for this person, from Core's activation preview. */
const RowSchema = z.object({
  target: z.object({ type: z.string(), id: z.string() }),
  operations: z.array(z.string()),
  own: z.boolean(),
  isNew: z.boolean(),
  check: z.enum(["manages", "blocked", "has", "unknown"]),
  title: z.string().nullable(),
  typeTitle: z.string().nullable(),
  managers: z.array(z.object({ name: z.string(), firstName: z.string().nullable() })),
});
const PreviewSchema = z.object({
  codeId: z.string(),
  title: z.string(),
  versionId: z.string(),
  number: z.number().int(),
  running: z.number().int().nullable(),
  latest: z.number().int(),
  activated: z.object({ at: z.string(), byYou: z.boolean(), byName: z.string().nullable() }).nullable(),
  allowed: z.union([
    z.object({ allowed: z.literal(true) }),
    z.object({ allowed: z.literal(false), reason: z.enum(["phone", "credential"]) }),
  ]),
  readiness: z.union([
    z.object({ state: z.enum(["ready", "approval_pending"]) }),
    z.object({ state: z.literal("refused"), code: z.string(), message: z.string() }),
  ]),
  place: z.object({ title: z.string(), typeTitle: z.string().nullable(), href: z.string().nullable() }).nullable(),
  rows: z.array(RowSchema),
});
export type CodeVersionPreview = z.infer<typeof PreviewSchema>;
export type CodeVersionPreviewRow = z.infer<typeof RowSchema>;

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
