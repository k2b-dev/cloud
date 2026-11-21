import { documentNavigate } from "@k2b/ssr/nav";
import { Button, ChangeList, NoticeCard, prompts } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { ActivationSchema, type CodeActivationStatus, type CodePageData, type CodePageReady, type CodePageVersion, wrapped } from "./data";
import { type PageText, personal, withQuery } from "./page-kit";

/** Polls bound the wait in the dialog; activation keeps going durably in Core after that. */
const ACTIVATION_POLLS = 90;
const ACTIVATION_POLL_MS = 1_000;

type ActivationRoute = "activate" | "activation/read";
/** Core's activation routes take only interactive credentials: the person's own browser session. */
const activationRequest = async (
  route: ActivationRoute,
  body: unknown,
): Promise<
  | { ok: true; data: CodeActivationStatus }
  /** `definite`: Core answered with a refusal, so it did not act. Otherwise the outcome is unknown. */
  | { ok: false; message: string | null; definite: boolean; notFound?: boolean }
> => {
  try {
    const response = await fetch(`/api/code/${route}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = json && typeof json === "object" && "message" in json && typeof json.message === "string" ? json.message : null;
      return { ok: false, message, definite: response.status >= 400 && response.status < 500, notFound: response.status === 404 };
    }
    const parsed = wrapped(ActivationSchema).safeParse(json);
    return parsed.success ? { ok: true, data: parsed.data.data } : { ok: false, message: null, definite: false };
  } catch {
    return { ok: false, message: null, definite: false };
  }
};

/**
 * An activation whose outcome is unknown survives closing the dialog and reloading the page in this tab, so asking
 * again resumes it instead of starting a second one. It is cleared only by a confirmed result or a refusal.
 */
const pendingActivation = (codeId: string, versionId: string) => {
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
        // Without storage the identity lives as long as the dialog.
      }
    },
  };
};

/**
 * Switching on needs an editor, a waiting version that no administrator still has to approve, and the list of what
 * it asks for; without that list the person could not see what they confirm.
 */
export const switchOnReady = (state: CodePageReady) =>
  state.permission === "editor" &&
  state.waiting !== null &&
  state.waiting.status !== "pending" &&
  state.waitingTargets !== null &&
  !state.versionsFailed;

type ActivationView =
  | { kind: "idle" }
  | { kind: "progress"; state: CodeActivationStatus["state"] }
  /** Core's answer is missing or the wait ended: the activation may still run, so nothing claims it did not. */
  | { kind: "unknown" }
  | { kind: "failed"; failure: NonNullable<CodeActivationStatus["failure"]> | null; message: string | null };

/** "Switch on": reviews the version, then runs Core's durable activation and shows its result. */
export async function openActivationDialog(params: { data: CodePageData; state: CodePageReady; version: CodePageVersion; text: PageText }) {
  const t = params.text.t();
  await prompts.dialog<void>((close) => <ActivationDialog {...params} close={() => close()} />, {
    title: t.activateTitle({ version: params.version.number }),
    icon: "ti ti-power",
    size: "large",
  });
}

function ActivationDialog(props: {
  data: CodePageData;
  state: CodePageReady;
  version: CodePageVersion;
  text: PageText;
  close: () => void;
}) {
  const t = props.text.t;
  const [view, setView] = createSignal<ActivationView>({ kind: "idle" });
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const running = () => props.state.active?.number ?? null;
  /** What switching on changes, in words: only additions and removals, the unchanged rest is counted. */
  const changes = () => {
    const words = props.state.words?.proposal;
    if (!words || words.versionId !== props.version.id) return null;
    return words.changes.rows.items.filter((row) => row.kind !== "same");
  };
  // One identity per attempt: after a lost answer, asking again with it returns the same durable activation.
  // Only a confirmed terminal result or a refusal starts a new identity.
  const pending = pendingActivation(props.state.code.id, props.version.id);
  const resumed = pending.read();
  let activationId = resumed ?? crypto.randomUUID();
  const finish = () => {
    pending.write(null);
    activationId = crypto.randomUUID();
  };
  /** Applies one status; true when it ended the wait. */
  const settle = (status: CodeActivationStatus): boolean => {
    if (status.state === "active") {
      pending.write(null);
      props.close();
      documentNavigate(withQuery(props.data.href, { activated: String(props.version.number) }));
      return true;
    }
    if (status.state === "failed" || status.state === "cancelled") {
      finish();
      setView({ kind: "failed", failure: status.failure, message: null });
      return true;
    }
    setView({ kind: "progress", state: status.state });
    return false;
  };
  const follow = async () => {
    for (let poll = 0; poll < ACTIVATION_POLLS && !disposed; poll++) {
      await new Promise((resolve) => setTimeout(resolve, ACTIVATION_POLL_MS));
      if (disposed) return;
      const read = await activationRequest("activation/read", { codeId: props.state.code.id, activationId });
      if (read.ok && settle(read.data)) return;
    }
    if (!disposed) setView({ kind: "unknown" });
  };
  /** Reads the status only; it never starts an activation. */
  const check = async () => {
    setView({ kind: "progress", state: "pending" });
    const read = await activationRequest("activation/read", { codeId: props.state.code.id, activationId });
    if (read.ok) {
      if (!settle(read.data)) await follow();
      return;
    }
    // Core has no such activation: nothing changed, and switching on again may reuse this identity.
    if (read.notFound) {
      pending.write(null);
      return setView({ kind: "failed", failure: null, message: null });
    }
    setView({ kind: "unknown" });
  };
  const start = async () => {
    setView({ kind: "progress", state: "pending" });
    pending.write(activationId);
    const started = await activationRequest("activate", { codeId: props.state.code.id, versionId: props.version.id, activationId });
    if (started.ok) {
      if (!settle(started.data)) await follow();
      return;
    }
    if (started.definite) {
      // Core refused before acting; a later attempt is a new activation.
      finish();
      return setView({ kind: "failed", failure: null, message: started.message });
    }
    // The answer was lost: Core may have accepted. Its status says what happened.
    await check();
  };
  // A dialog opened while an earlier attempt is unresolved continues with that attempt.
  if (resumed) void check();
  const failureText = (): string | null => {
    const current = view();
    if (current.kind !== "failed") return null;
    if (!current.failure) return current.message ?? t().activationUnavailable;
    return t().failedGeneric({ reason: current.failure.reason });
  };
  const progressText = () => {
    const current = view();
    if (current.kind === "unknown") return t().activationUnknown({ running: running() });
    if (current.kind !== "progress") return null;
    if (current.state === "waiting") return t().waitingOwner({ running: running() });
    if (current.state === "applying" || current.state === "rolling_back") return t().applying;
    return t().checking;
  };
  const busy = () => view().kind === "progress";
  return (
    <div class="cloud-code__dialog">
      <p>{personal(props.data) ? t().personalActivateIntro : t().activateIntro({ name: props.data.owner.title })}</p>
      <Show when={changes()?.length}>
        <ChangeList
          marker="sign"
          label={t().changesTitle}
          items={changes()!.map((row) => ({
            tone: row.kind === "remove" ? ("remove" as const) : ("add" as const),
            content: row.text,
            detail: row.note,
          }))}
        />
      </Show>
      <Show when={!props.data.activation.allowed}>
        <NoticeCard
          tone="warning"
          icon="ti ti-device-mobile-off"
          detail={props.data.activation.allowed ? "" : props.data.activation.reason === "phone" ? t().phoneBlocked : t().credentialBlocked}
          title={t().switchOn}
        />
      </Show>
      <Show when={progressText()}>
        {(progress) => (
          <p class="cloud-code__progress" role="status">
            <i class="ti ti-loader-2 animate-spin" aria-hidden="true" /> {progress()}
          </p>
        )}
      </Show>
      <Show when={failureText()}>
        {(failure) => (
          <NoticeCard
            tone="danger"
            icon="ti ti-alert-triangle"
            title={failure()}
            detail={t().nothingChanged({ running: running() })}
            role="alert"
          />
        )}
      </Show>
      <div class="cloud-code__dialog-actions">
        <Button type="button" variant="secondary" onClick={() => props.close()}>
          {view().kind === "idle" ? t().cancel : t().close}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!props.data.activation.allowed || busy()}
          loading={busy() && view().kind === "progress" && (view() as { state: string }).state !== "waiting"}
          onClick={() => void (view().kind === "unknown" ? check() : start())}
        >
          <i class="ti ti-power" aria-hidden="true" />
          {view().kind === "unknown"
            ? t().checkStatus
            : view().kind === "failed"
              ? t().tryAgain
              : t().switchOnVersion({ version: props.version.number })}
        </Button>
      </div>
    </div>
  );
}
