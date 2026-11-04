import type { DateContext } from "@k2b/stdlib";
import { z } from "zod";
import type { CapabilityClientResult, CapabilityInvocation } from "../../capabilities/types";
import type { CloudResourceRef } from "../../contracts/capabilities";
import { CODE_BRIDGE_REFUSAL_KINDS, type CodeBridgeRefusalKind } from "../../contracts/code-call";
import { CodeInternetOriginsSchema } from "../../contracts/code-internet";

/**
 * The shared Code page reads Core's public `core.code.*` queries and the Core activation routes, like any
 * application could. These schemas keep only the fields the page shows; Core's contracts stay the authority and
 * may add fields.
 */
const CodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** A2: the credentialless account handle; A3b uses this in the refusal notice. */
  serviceAccountHandle: z.string().nullable().optional(),
  state: z.enum(["draft", "active", "paused", "deleting"]),
  activeVersionId: z.string().nullable(),
  pauseReason: z.string().nullable(),
});
export const CodeReadSchema = z.object({
  code: CodeSchema.extend({
    owner: z.union([z.object({ kind: z.literal("person"), userId: z.string() }), z.object({ kind: z.enum(["resource", "app"]) })]),
  }),
  permission: z.enum(["editor", "reader"]),
});
export const CodeListSchema = z.object({
  items: z.array(CodeSchema.extend({ permission: z.enum(["editor", "reader"]) })),
  nextCursor: z.string().nullable(),
});
const VersionSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});
const VersionReceiptSchema = z.object({
  version: VersionSchema,
  status: z.enum(["submitted", "pending", "approved", "rejected", "expired", "cancelled"]),
  decision: z.object({ approved: z.boolean(), decidedBy: z.string().nullable(), decidedAt: z.string(), label: z.string() }).nullable(),
});
export const VersionListSchema = z.object({ items: z.array(VersionReceiptSchema), nextBefore: z.number().int().nullable() });
export const VersionReadSchema = z.object({
  version: VersionSchema,
  content: z.object({ text: z.string(), nextOffset: z.number().int().nullable() }).nullable(),
});
const PermissionSchema = z.object({
  operation: z.string(),
  target: z.object({ type: z.string(), id: z.string().nullable() }).nullable(),
  file: z.string(),
  line: z.number().int(),
});
/** The parts of the checked version manifest the page shows. */
export const ManifestSchema = z.object({
  /** Reviewed secret bindings: which secret and destination this version may use, for the secrets tab. */
  secrets: z.array(z.object({ name: z.string(), binding_revision: z.string(), origin: z.string() })).optional(),
  internet: CodeInternetOriginsSchema.optional(),
  entrypoints: z.array(
    z.object({ kind: z.enum(["schedule", "manual"]), entrypoint: z.string(), title: z.string().optional(), cron: z.string().nullable() }),
  ),
  permissions: z.array(PermissionSchema),
});
export const VersionDiffSchema = z.object({
  staleComparison: z.boolean(),
  binding: z.object({ comparisonVersionId: z.string().nullable() }),
  files: z.array(z.object({ path: z.string(), lines: z.array(z.object({ kind: z.enum(["same", "add", "del"]), text: z.string() })) })),
  permissions: z.array(PermissionSchema),
});
const RunSchema = z.object({
  id: z.string(),
  versionId: z.string(),
  trigger: z.enum(["manual", "schedule", "event", "path"]),
  entrypoint: z.string(),
  title: z.string().optional(),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "skipped"]),
  outcome: z.string().nullable(),
  /** The first call a target refused. It names no target, so readers get it too; older Cores leave it out. */
  firstRefusedCallOrdinal: z.number().int().positive().nullable().optional(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  /** The failed run this one starts again. */
  rerunOf: z.string().nullable().optional(),
  /** Who started it again, as the directory shows them to this viewer. */
  rerunByName: z.string().nullable().optional(),
});
export const RunListSchema = z.object({ items: z.array(RunSchema), nextCursor: z.string().nullable() });
const CallSchema = z.object({
  ordinal: z.number().int(),
  kind: z.enum(["query", "action"]),
  capability: z.string(),
  call: z.json().nullable(),
  result: z.json().nullable(),
  state: z.enum(["running", "succeeded", "failed", "uncertain"]),
  /** How the bridge classified a refusal while it still knew the target's status. */
  refusalKind: z.enum(CODE_BRIDGE_REFUSAL_KINDS).nullable().optional(),
});
export const RunReadSchema = z.object({
  run: RunSchema,
  contents: z
    .object({
      input: z.json(),
      inputChunked: z.boolean(),
      content: z.object({ text: z.string(), nextOffset: z.number().int().nullable() }).nullable(),
      calls: z.array(CallSchema),
      nextCursor: z.number().int().nullable(),
      /** The call `run.firstRefusedCallOrdinal` names, read in the same request. */
      firstRefusedCall: z
        .object({
          ordinal: z.number().int(),
          kind: z.enum(["query", "action"]),
          capability: z.string(),
          target: z.object({ type: z.string(), id: z.string() }).nullable(),
        })
        .nullable()
        .optional(),
    })
    .nullable(),
});
export const ActivationSchema = z.object({
  id: z.string(),
  versionId: z.string(),
  state: z.enum(["pending", "preflight", "applying", "waiting", "rolling_back", "failed", "active", "cancelled"]),
  failure: z
    .object({
      target: z.object({ type: z.string(), id: z.string() }).nullable(),
      code: z.string(),
      reason: z.string(),
    })
    .nullable(),
});
export type CodeActivationStatus = z.infer<typeof ActivationSchema>;
/** Core's answer before the click: a target left out needs no new answer. */
export const ActivationCheckSchema = z.object({
  targets: z.array(
    z.object({
      target: z.object({ type: z.string(), id: z.string() }),
      state: z.enum(["granted", "refused", "unknown"]),
      failure: ActivationSchema.shape.failure,
    }),
  ),
});
export type CodeActivationCheck = z.infer<typeof ActivationCheckSchema>;
export const StartSchema = z.object({ runId: z.string(), duplicate: z.boolean() });
export const AutomationListSchema = z.object({
  items: z.array(z.object({ entrypoint: z.string(), title: z.string().optional(), nextRunAt: z.string().nullable() })),
});
/** Metadata only: Core has no operation that returns a secret's value. */
const SecretSchema = z.object({
  name: z.string(),
  binding_revision: z.string(),
  origin: z.string(),
  pathPrefix: z.string(),
  headers: z.array(z.string()),
  configured: z.boolean(),
});
export const SecretListSchema = z.object({
  items: z.array(SecretSchema.extend({ valueSetBy: z.string().nullable(), valueSetAt: z.string().nullable() })),
  nextCursor: z.string().nullable(),
});
export const SecretSetSchema = z.object({ secret: SecretSchema });

/** What the owner's navigation shows: an entry when the person may see this Code, and a warning dot when it needs someone. */
export type CodeAttention = { visible: boolean; attention: boolean };

/** One caller-supplied transport: the server passes the request's credentials, the browser its session. */
export type CodePageInvoke = <T extends z.ZodType>(
  invocation: CapabilityInvocation,
  schema: T,
) => Promise<CapabilityClientResult<z.output<T>>>;
export const coreQuery = (capabilityId: string, input: unknown): CapabilityInvocation => ({
  appId: "core",
  capabilityId,
  kind: "query",
  input,
});
/** Direct Core HTTP routes return `{ data }`; capability clients already validate their own envelope. */
export const wrapped = <T extends z.ZodType>(schema: T) => z.object({ data: schema });

export type CodePagePerson = { id: string; name: string };
/**
 * A target or the owner, described from its app's manifest in the registry. The page never asks the target's app, so
 * a foreign target has only its type, ID and, where the type's page pattern allows, a link; its app names it once
 * someone opens that link and may read it.
 */
export type CodePageTarget = {
  key: string;
  ref: { type: string; id: string };
  /** The owner's own title, or an app's name for an app-wide target; null for every other target. */
  title: string | null;
  /** The target type's name in its app, such as "Space". */
  typeTitle: string | null;
  /** The target type's icon class from its app's catalog. */
  icon: string | null;
  /** The owner resource itself. */
  own: boolean;
  /** The type's page with only this ID filled in; null when its pattern needs more than the ID or it has none. */
  href: string | null;
};
/** Operations at one target, as the checker read them from the handles in the Code: what it calls, not what it may. */
export type CodePageTargetRow = {
  target: CodePageTarget;
  /** Operations of the running version. */
  operations: string[];
  /** Operations only the waiting version adds here. */
  newOperations: string[];
};
/** One target the waiting version needs, for the switch-on dialog. The owner is always checked. */
export type CodePageActivationRow = { target: CodePageTarget; operations: string[]; isNew: boolean };
export type CodePageRun = z.infer<typeof RunSchema> & { versionNumber: number | null };
export type CodePageCall = {
  ordinal: number;
  kind: "query" | "action";
  capability: string;
  target: { type: string; id: string } | null;
  /** Additional resources the call named. */
  refs: { type: string; id: string }[];
  /** How the bridge classified its refusal; null for calls it did not refuse and for older records. */
  refusal: CodeBridgeRefusalKind | null;
  state: "running" | "succeeded" | "failed" | "uncertain";
  /** A short readable summary of the result or error, never the full payload. */
  summary: string | null;
};
export type CodePageRunDetail = {
  run: CodePageRun;
  /** Null for readers: they see when and how a run ended, never its contents. */
  calls: CodePageCall[] | null;
  nextCallCursor: number | null;
  /** The run's input, needed to run it again. */
  input: unknown;
  /** The refusal this failed run recorded; null when it did not fail or recorded none. */
  refusal: CodePageRefusal | null;
  /** The input is too large to carry along; "Run again" points to cld code instead. */
  inputTooLarge: boolean;
};
export type CodePageAutomation = {
  entrypoint: string;
  /** Reviewed human title; absent on older versions. */
  title?: string;
  kind: "schedule" | "manual";
  cron: string | null;
  /** Only the waiting version has it. */
  isNew: boolean;
  lastRun: CodePageRun | null;
  /** When the scheduler runs it next; absent when it does not or Core cannot say. */
  nextRunAt?: string | null;
};
/**
 * A refused call of a failed run, as the bridge recorded it. It is a fact, not the run's cause: the Code may have
 * caught the refusal and failed for another reason.
 */
export type CodePageRefusal = {
  /**
   * `target_refused`: the target answered 403 or 404, so either the account lacks the right or the target does not
   * exist. `policy`: the Cloud admin's policy never allows the call. `approval`: this version needs the Cloud admin's
   * approval for it.
   */
  kind: Extract<CodeBridgeRefusalKind, "target_refused" | "policy" | "approval">;
  runId: string;
  versionId: string;
  /** What the Code called; null for readers, who see no calls, because a target ID can come from runtime data. */
  call: { capability: string; title: string | null; target: CodePageTarget | null } | null;
};
export type CodePageVersion = {
  id: string;
  number: number;
  /** Null for a version older than the loaded history page; its receipt was not read. */
  status: z.infer<typeof VersionReceiptSchema>["status"] | null;
  createdBy: CodePagePerson | null;
  createdAt: string;
  decisionLabel: string | null;
  decidedBy: CodePagePerson | null;
  active: boolean;
};
export type CodePageDiff = {
  version: CodePageVersion;
  /** The previous version's number; null for a first version, "unknown" when it could not be read. */
  comparison: number | "unknown" | null;
  staleComparison: boolean;
  internet: string[] | null;
  files: z.infer<typeof VersionDiffSchema>["files"];
  permissions: { operation: string; target: CodePageTarget | null; file: string; line: number }[];
};
/** One secret of this Code: where its value may go and who wrote it, never the value. */
export type CodePageSecret = z.infer<typeof SecretSchema> & {
  valueSetBy: CodePagePerson | null;
  valueSetAt: string | null;
  /** The running and the waiting version, when they use this name. */
  usedIn: { number: number; state: "active" | "waiting" }[];
  /** No saved version uses this destination yet, so submitting one is still open. Null when that could not be read. */
  unsubmitted: boolean | null;
};
/** What just happened on the secrets tab, from the URL, so a reload keeps it. */
export type CodeSecretNotice = "replaced" | "submitted" | "saved" | "submit-failed";
export type CodePageSecrets = {
  items: CodePageSecret[];
  /** More secrets than one page loads; `cld code secret list` reads them all. */
  more: boolean;
  selected: string | null;
  notice: CodeSecretNotice | null;
  /** The newest saved version, which a new destination is submitted against. */
  latest: { id: string; number: number } | null;
};
export type CodePageTab = "overview" | "runs" | "secrets" | "versions";
export type CodePageReady = {
  kind: "ready";
  code: z.infer<typeof CodeSchema>;
  permission: "editor" | "reader";
  versions: CodePageVersion[];
  /** Core could not list the versions; switching on waits until it can. */
  versionsFailed: boolean;
  moreVersions: boolean;
  active: CodePageVersion | null;
  /** The newest version when it is newer than the running one and not rejected, expired, or cancelled. */
  waiting: CodePageVersion | null;
  automations: CodePageAutomation[] | null;
  /** Core's attention reasons for this Code, the same answer the owner's navigation uses; null when unavailable. */
  attentionReasons: string[] | null;
  /** Full declared lists for the running and waiting versions; null means the manifest could not be read. */
  internet: { active: string[] | null; waiting: string[] | null };
  /** What the running and the waiting version call; null when a manifest could not be read. */
  targets: CodePageTargetRow[] | null;
  /** The refusal of the newest finished run, when that run failed with one. */
  refusal: CodePageRefusal | null;
  /** What switching on the waiting version asks for; null without a waiting version or when unreadable. */
  waitingTargets: CodePageActivationRow[] | null;
  runs: { items: CodePageRun[]; nextCursor: string | null } | null;
  run: CodePageRunDetail | null;
  /** The selected version and its difference to the previous one. */
  diff: CodePageDiff | null;
  /** The selected version or run could not be read. */
  selectionFailed: boolean;
  /** Only on the secrets tab, which only editors reach; null there when Core could not list them. */
  secrets: CodePageSecrets | null;
};
export type CodePageState = { kind: "none" } | { kind: "no-access" } | { kind: "error" } | CodePageReady;
/** Serializable initial data from `loadCodePage`, rendered unchanged by the server and the browser. */
export type CodePageData = {
  /**
   * Whose Code this is. A resource's Code acts on behalf of `ref`; personal Code (`ref: null`) runs as its person, and
   * `title` is then the Code's own title.
   */
  owner: {
    kind: "resource" | "person";
    ref: CloudResourceRef | null;
    title: string;
    typeTitle: string | null;
    /** Personal Code of someone else, shared with the viewer: whose rights it runs with. Null for the viewer's own. */
    runsAs?: { name: string | null } | null;
  };
  /** This page's path; tabs and selections add query parameters, and "Copy link" shares it. */
  href: string;
  tab: CodePageTab;
  canManageOwner: boolean;
  /** Activation needs an interactive browser session or a personal OAuth credential. */
  activation: { allowed: true } | { allowed: false; reason: "phone" | "credential" };
  /** A panel that works on Code with the person, offered as "Edit with …" under its own name and icon. */
  editor: { provider: string; label: string; icon: string } | null;
  dates: DateContext & { now: string };
  /** The page reloaded right after this version was switched on. */
  activatedNotice: number | null;
  /** The viewer is a Cloud admin, who decides approvals; others are not offered the approval link. */
  cloudAdmin: boolean;
  state: CodePageState;
};

export type { CloudResourceRef };
