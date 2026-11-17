import { useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { useAssistantLive } from "./assistant-live";
import {
  type CodeVersionActivation,
  pendingCodeVersionActivation,
  readCodeVersionActivation,
  requestCodeVersionAgain,
  startCodeVersionActivation,
  stopCodeReviewRevision,
  withdrawCodeVersion,
} from "./code-activation";
import { type CodeVersionCardStore, createCodeVersionCardStore } from "./code-version-card-store";
import { codeVersionCardMessages } from "./code-version-card-messages";
import {
  type CodeVersionCardAction,
  type CodeVersionCardActivation,
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
  store?: CodeVersionCardStore;
  initialAction?: CodeVersionCardAction["id"];
  onActivated?: () => void;
  onAsk?: (text: string) => void;
}) {
  const locale = useLocale();
  const live = useAssistantLive();
  const t = () => codeVersionCardMessages.resolve([locale()]).t;
  const store = props.store ?? createCodeVersionCardStore(live);
  const [activation, setActivation] = createSignal<CodeVersionCardActivation>({ kind: "idle" });
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

  const ref = () => ({ codeId: props.codeId, versionId: versionId() });
  const loaded = () => store.read(ref());
  const load = () => store.refresh(ref());
  createEffect(() => onCleanup(store.retain(ref())));

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
    if (pending.read()) void check();
    else if (props.initialAction) onAction(props.initialAction);
  });
  const model = createMemo(() =>
    describeCodeVersionCard({
      value: loaded(),
      version: number(),
      versionId: versionId(),
      locale: locale(),
      timeZone: props.timeZone,
      activation: activation(),
      nextRun: null,
      canAsk: Boolean(props.onAsk),
      actionError: actionError(),
      actionBusy: actionBusy(),
    }),
  );
  return <CodeVersionCardView model={model()} anchorId={codeVersionCardAnchor(props.versionId)} onAction={onAction} />;
}
