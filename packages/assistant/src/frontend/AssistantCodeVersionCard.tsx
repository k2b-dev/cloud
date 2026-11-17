import { useLocale } from "@k2b/ui";
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { loadCodeNextRun } from "../code-summary";
import { matchesAssistantInvalidation, useAssistantLive } from "./assistant-live";
import {
  type CodeVersionActivation,
  loadCodeVersionPreview,
  loadCodeVersionReview,
  loadCodeVersionWords,
  pendingCodeVersionActivation,
  readCodeVersionActivation,
  requestCodeVersionAgain,
  startCodeVersionActivation,
  stopCodeReviewRevision,
  withdrawCodeVersion,
} from "./code-activation";
import { browserCodeInvoke } from "./code-client";
import { loadCodeVersionCardContext, loadLatestCodeVersion } from "./code-version-card-data";
import { codeVersionCardMessages } from "./code-version-card-messages";
import {
  type CodeVersionCardAction,
  type CodeVersionCardActivation,
  type CodeVersionCardLoaded,
  describeCodeVersionCard,
} from "./code-version-card-state";
import { CodeVersionCardView } from "./code-version-card-view";

const POLLS = 90;
const POLL_MS = 1_000;
const RECHECK_MS = 30_000;

/** The stable anchor also survives asking for approval again. */
export const codeVersionCardAnchor = (versionId: string) => `code-version-${versionId}`;

/** One saved version, one calm form; Core remains the authority for review, activation and openable pages. */
export default function AssistantCodeVersionCard(props: {
  codeId: string;
  versionId: string;
  number: number;
  timeZone: string;
  onActivated?: () => void;
  onAsk?: (text: string) => void;
}) {
  const locale = useLocale();
  const live = useAssistantLive();
  const t = () => codeVersionCardMessages.resolve([locale()]).t;
  const [loaded, setLoaded] = createSignal<CodeVersionCardLoaded | "failed" | "denied" | null>(null);
  const [activation, setActivation] = createSignal<CodeVersionCardActivation>({ kind: "idle" });
  const [nextRun, setNextRun] = createSignal<string | null>(null);
  const [versionId, setVersionId] = createSignal(props.versionId);
  const [number, setNumber] = createSignal(props.number);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [actionBusy, setActionBusy] = createSignal(false);
  let disposed = false;
  let recheck: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    disposed = true;
    clearTimeout(recheck);
  });

  let reads = 0;
  let newest: Promise<boolean> = Promise.resolve(true);
  const load = (live = false): Promise<boolean> => {
    const read = ++reads;
    const id = versionId();
    const run = (async (): Promise<boolean> => {
      const [preview, review, words, context] = await Promise.all([
        loadCodeVersionPreview(props.codeId, id),
        loadCodeVersionReview(props.codeId, id),
        loadCodeVersionWords(props.codeId, id),
        loadCodeVersionCardContext(props.codeId, id),
      ]);
      const running = typeof preview === "object" && preview.running === preview.number;
      const [next, latest] = await Promise.all([
        running && context.code?.state === "active" ? loadCodeNextRun(browserCodeInvoke, props.codeId) : null,
        typeof preview === "object" && preview.latest > preview.number ? loadLatestCodeVersion(props.codeId) : null,
      ]);
      if (disposed) return false;
      if (read !== reads) return newest;
      if (live && loaded() !== null && (preview === "failed" || (typeof preview === "object" && review === null))) return false;
      setNextRun(next);
      setLoaded(typeof preview === "object" ? { preview, review, words, ...context, latest } : preview);
      return preview !== "failed" && (!running || context.code !== null);
    })();
    newest = run;
    return run;
  };

  // Lost responses resume the same durable attempt, including after a reload.
  let pending = pendingCodeVersionActivation(props.codeId, versionId());
  let activationId = pending.read() ?? crypto.randomUUID();
  const finish = () => {
    pending.write(null);
    activationId = crypto.randomUUID();
  };
  const settle = (status: CodeVersionActivation): boolean => {
    if (disposed) return true;
    if (status.state === "active") {
      props.onActivated?.();
      void load().then((ok) => {
        if (disposed) return;
        const current = loaded();
        const confirmed =
          ok &&
          current &&
          typeof current === "object" &&
          current.preview.running === number() &&
          current.code?.state === "active" &&
          current.code.activeVersionId === versionId();
        if (confirmed) {
          finish();
          setActivation({ kind: "idle" });
        } else setActivation({ kind: "unknown" });
      });
      return true;
    }
    if (status.state === "failed" || status.state === "cancelled") {
      finish();
      setActivation({ kind: "failed" });
      return true;
    }
    setActivation({ kind: "progress" });
    return false;
  };
  const follow = async () => {
    for (let poll = 0; poll < POLLS && !disposed; poll++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (disposed) return;
      const read = await readCodeVersionActivation(props.codeId, activationId);
      if (read.ok && settle(read.status)) return;
    }
    if (!disposed) setActivation({ kind: "unknown" });
  };
  const check = async () => {
    clearTimeout(recheck);
    setActivation({ kind: "checking" });
    const read = await readCodeVersionActivation(props.codeId, activationId);
    if (disposed) return;
    if (read.ok) {
      if (!settle(read.status)) await follow();
      return;
    }
    if (read.notFound) {
      pending.write(null);
      setActivation({ kind: "failed" });
      return;
    }
    setActivation({ kind: "unreadable" });
    recheck = setTimeout(() => void check(), RECHECK_MS);
  };
  const start = async () => {
    if (activation().kind === "progress" || activation().kind === "checking" || actionBusy()) return;
    const held =
      document.activeElement instanceof HTMLElement && document.activeElement.hasAttribute("data-code-version-primary")
        ? document.activeElement
        : null;
    setActivation({ kind: "progress" });
    pending.write(activationId);
    const started = await startCodeVersionActivation(props.codeId, versionId(), activationId);
    if (disposed) return;
    if (started.ok) {
      if (!settle(started.status)) await follow();
    } else if (started.definite) {
      finish();
      setActivation({ kind: "failed" });
    } else await check();
    if (held && activation().kind === "failed" && document.activeElement === document.body) {
      document
        .querySelector<HTMLElement>(`[data-chat-anchor="${codeVersionCardAnchor(props.versionId)}"] [data-code-version-primary]`)
        ?.focus();
    }
  };
  const mutate = async (kind: "stop" | "askAgain" | "withdraw") => {
    if (actionBusy() || activation().kind === "progress" || activation().kind === "checking") return;
    setActionBusy(true);
    setActionError(null);
    try {
      if (kind === "stop") {
        const answer = await stopCodeReviewRevision(props.codeId, versionId());
        if (!answer) {
          setActionError(t().stopFailed);
          return;
        }
        if (answer.status === "too_late" && answer.submittedNumber) setActionError(t().tooLate({ version: answer.submittedNumber }));
      } else if (kind === "askAgain") {
        const next = await requestCodeVersionAgain(props.codeId, versionId());
        if (!next) {
          setActionError(t().askAgainFailed);
          return;
        }
        pending = pendingCodeVersionActivation(props.codeId, next.id);
        activationId = pending.read() ?? crypto.randomUUID();
        setVersionId(next.id);
        setNumber(next.number);
        setActivation({ kind: "idle" });
      } else if (!(await withdrawCodeVersion(props.codeId, versionId()))) {
        setActionError(t().withdrawFailed);
        return;
      }
      await load();
    } finally {
      if (!disposed) setActionBusy(false);
    }
  };
  const onAction = (action: CodeVersionCardAction["id"]) => {
    if (action === "activate" || action === "retry") void start();
    else if (action === "check") void check();
    else if (action === "load") void load();
    else if (action === "stop" || action === "askAgain" || action === "withdraw") void mutate(action);
    else if (action === "rework" || action === "different") {
      const current = loaded();
      const name = current && typeof current === "object" ? (current.review?.decidedBy?.name ?? null) : null;
      props.onAsk?.(action === "rework" ? t().askRework({ version: number(), name }) : t().askDifferently({ version: number() }));
    }
  };
  onMount(() => {
    void load();
    if (pending.read()) void check();
    onCleanup(
      live.register({
        matches: matchesAssistantInvalidation(["code-versions"]),
        invalidate: async () => {
          if (!(await load(true))) throw new Error("The Code version could not be read again.");
        },
      }),
    );
  });
  const model = createMemo(() =>
    describeCodeVersionCard({
      value: loaded(),
      version: number(),
      versionId: versionId(),
      locale: locale(),
      timeZone: props.timeZone,
      activation: activation(),
      nextRun: nextRun(),
      canAsk: Boolean(props.onAsk),
      actionError: actionError(),
      actionBusy: actionBusy(),
    }),
  );
  return <CodeVersionCardView model={model()} anchorId={codeVersionCardAnchor(props.versionId)} onAction={onAction} />;
}
