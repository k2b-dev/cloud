import { FeatCodeMark } from "@k2b/cloud/code/ui";
import { Button, ButtonLink, Skeleton, useLocale } from "@k2b/ui";
import { codePageMessages } from "@k2b/cloud/ssr/code-page/messages";
import { codeTargetLabel, codeTargetName } from "@k2b/cloud/ssr/code-page/targets";
import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import {
  type CodeVersionActivation,
  type CodeVersionPreview,
  codeVersionOwnPageHref,
  codeVersionPageHref,
  loadCodeVersionPreview,
  pendingCodeVersionActivation,
  readCodeVersionActivation,
  startCodeVersionActivation,
} from "./code-activation";
import { loadCodeNextRun } from "../code-summary";
import { browserCodeInvoke, formatCodeNextRun, formatCodeTime } from "./code-client";
import { assistantMessages } from "./messages";

const POLLS = 90;
const POLL_MS = 1_000;

type Loaded = Awaited<ReturnType<typeof loadCodeVersionPreview>> | null;
type Activation =
  | { kind: "idle" }
  | { kind: "progress"; state: CodeVersionActivation["state"] }
  /** Core's answer is missing or the wait ended: the activation may still run, so nothing claims it did not. */
  | { kind: "unknown" }
  | { kind: "failed"; reason: string | null };

/** A time today shows as the time alone, like the mockup's line; other days keep their date. */
const switchedOnWhen = (at: string, locale: string, timeZone: string, now: Date): string => {
  const day = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(date);
  try {
    return day(new Date(at)) === day(now)
      ? new Intl.DateTimeFormat(locale, { timeZone, timeStyle: "short" }).format(new Date(at))
      : formatCodeTime(at, locale, timeZone);
  } catch {
    return formatCodeTime(at, locale, timeZone);
  }
};

/**
 * The saved version and its approval/credential state. Switching on creates no target rights.
 * Once switched on, a reload reads the same state from Core.
 */
export default function AssistantCodeVersionCard(props: {
  codeId: string;
  versionId: string;
  number: number;
  timeZone: string;
  onActivated?: () => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => assistantMessages.resolve([locale()]).t);
  // Targets read exactly as on the Code page.
  const pageT = createMemo(() => codePageMessages.resolve([locale()]).t);
  /** The own place by its title where this person may read it, else by its type and ID, as foreign targets are. */
  const targetLabel = (target: NonNullable<NonNullable<CodeVersionPreview["targets"]>[number]["target"]>, place: string | null) =>
    codeTargetLabel(target, place ?? codeTargetName({ ...target, own: false }, ""), pageT());
  const [loaded, setLoaded] = createSignal<Loaded>(null);
  const [activation, setActivation] = createSignal<Activation>({ kind: "idle" });
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const [nextRun, setNextRun] = createSignal<string | null>(null);
  const load = async () => {
    setLoaded(null);
    const preview = await loadCodeVersionPreview(props.codeId, props.versionId);
    // A running version shows its next run in the same paint as its line, so nothing moves once it arrives.
    setNextRun(
      typeof preview === "object" && preview.running === props.number ? await loadCodeNextRun(browserCodeInvoke, props.codeId) : null,
    );
    setLoaded(preview);
  };
  // One identity per attempt: after a lost answer, asking again with it returns the same durable activation.
  const pending = pendingCodeVersionActivation(props.codeId, props.versionId);
  let activationId = pending.read() ?? crypto.randomUUID();
  const finish = () => {
    pending.write(null);
    activationId = crypto.randomUUID();
  };
  /** Applies one status; true when it ended the wait. */
  const settle = (status: CodeVersionActivation): boolean => {
    if (status.state === "active") {
      pending.write(null);
      setActivation({ kind: "idle" });
      props.onActivated?.();
      void load();
      return true;
    }
    if (status.state === "failed" || status.state === "cancelled") {
      finish();
      setActivation({ kind: "failed", reason: status.failure?.reason ?? null });
      return true;
    }
    setActivation({ kind: "progress", state: status.state });
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
  /** Reads the status only; it never starts an activation. */
  const check = async () => {
    setActivation({ kind: "progress", state: "pending" });
    const read = await readCodeVersionActivation(props.codeId, activationId);
    if (read.ok) {
      if (!settle(read.status)) await follow();
      return;
    }
    // Core has no such activation: nothing changed, and switching on again may reuse this identity.
    if (read.notFound) {
      pending.write(null);
      setActivation({ kind: "failed", reason: null });
      return;
    }
    setActivation({ kind: "unknown" });
  };
  const start = async () => {
    setActivation({ kind: "progress", state: "pending" });
    pending.write(activationId);
    const started = await startCodeVersionActivation(props.codeId, props.versionId, activationId);
    if (started.ok) {
      if (!settle(started.status)) await follow();
      return;
    }
    if (started.definite) {
      // Core refused before acting; a later attempt is a new activation.
      finish();
      setActivation({ kind: "failed", reason: started.message });
      return;
    }
    // The answer was lost: Core may have accepted. Its status says what happened.
    await check();
  };
  onMount(() => {
    void load();
    // A card opened while an earlier attempt is unresolved continues with that attempt.
    if (pending.read()) void check();
  });

  const preview = () => {
    const current = loaded();
    return current && typeof current === "object" ? current : null;
  };
  const busy = () => activation().kind === "progress";
  const spinning = () => {
    const current = activation();
    return current.kind === "progress" && current.state !== "waiting";
  };
  const failedReason = () => {
    const current = activation();
    return current.kind === "failed" ? { reason: current.reason } : null;
  };
  const refusedMessage = () => {
    const readiness = preview()?.readiness;
    return readiness?.state === "refused" ? readiness.message : null;
  };
  const notAllowed = () => {
    const allowed = preview()?.allowed;
    return allowed && !allowed.allowed ? allowed.reason : null;
  };
  const progressText = () => {
    const current = activation();
    if (current.kind === "unknown") return t().codeVersionUnknown;
    if (current.kind !== "progress") return null;
    if (current.state === "waiting") return t().codeVersionWaiting;
    return current.state === "applying" || current.state === "rolling_back" ? t().codeVersionApplying : t().codeVersionChecking;
  };
  const page = () => {
    const current = preview();
    return current ? codeVersionPageHref(current) : null;
  };
  const ownPage = () => {
    const current = preview();
    return current ? codeVersionOwnPageHref(current) : null;
  };
  const diffHref = () => {
    const current = preview();
    const page = current && codeVersionPageHref(current);
    return page ? `${page}?tab=versions&version=${encodeURIComponent(props.versionId)}` : null;
  };
  const diffLink = () => (
    <Show when={diffHref()}>
      {(href) => (
        <ButtonLink href={href()} size="sm" variant="secondary">
          <i class="ti ti-git-compare" aria-hidden="true" />
          {t().codeVersionDiff}
        </ButtonLink>
      )}
    </Show>
  );

  return (
    <Switch>
      <Match when={loaded() === null}>
        <div class="assistant-code-version" role="status" aria-busy="true" aria-label={t().codeVersionLoading} data-state="loading">
          <Skeleton class="h-3.5 w-3/5" />
          <Skeleton class="h-3 w-4/5" />
          <Skeleton class="h-7 w-32" />
        </div>
      </Match>
      <Match when={loaded() === "failed"}>
        <div class="assistant-code-version" role="alert" data-state="error">
          <p class="assistant-code-version__title">{t().codeVersionLoadFailed}</p>
          <div class="assistant-code-version__actions">
            <Button type="button" size="sm" variant="secondary" onClick={() => void load()}>
              <i class="ti ti-refresh" aria-hidden="true" />
              {t().codeBlockRetry}
            </Button>
          </div>
        </div>
      </Match>
      <Match when={loaded() === "denied"}>
        <p class="assistant-code-version__line" data-state="denied">
          <i class="ti ti-lock" aria-hidden="true" />
          {t().codeVersionNoAccess({ version: props.number })}
        </p>
      </Match>
      <Match when={preview()?.running === props.number}>
        <div class="assistant-code-version__on">
          <p class="assistant-code-version__line" data-tone="ok" data-state="on" role="status">
            <i class="ti ti-circle-check" aria-hidden="true" />
            <Show when={preview()?.activated} fallback={t().codeVersionOnPlain({ version: props.number })}>
              {(activated) => {
                const when = () => switchedOnWhen(activated().at, locale(), props.timeZone, new Date());
                if (activated().byYou) return t().codeVersionOn({ version: props.number, when: when() });
                const name = activated().byName;
                // A name this person may not see, or an account that is gone, stays out of the line.
                return name
                  ? t().codeVersionOnBy({ version: props.number, when: when(), name })
                  : t().codeVersionOnNeutral({ version: props.number, when: when() });
              }}
            </Show>
          </p>
          <Show when={ownPage() || nextRun() || page()}>
            <div class="assistant-code-version__links">
              <Show when={ownPage()}>
                {(href) => (
                  <ButtonLink href={href()} size="sm" variant="secondary">
                    <i class="ti ti-external-link" aria-hidden="true" />
                    {t().codeVersionOpenPage}
                  </ButtonLink>
                )}
              </Show>
              <Show when={nextRun()}>
                {(when) => {
                  const label = () => t().codeVersionNextRun({ when: formatCodeNextRun(when(), locale(), props.timeZone) });
                  return (
                    <Show
                      when={page()}
                      fallback={
                        <span class="assistant-code-version__next">
                          <i class="ti ti-clock" aria-hidden="true" />
                          {label()}
                        </span>
                      }
                    >
                      {(href) => (
                        <ButtonLink href={href()} size="sm" variant="ghost">
                          <i class="ti ti-clock" aria-hidden="true" />
                          {label()}
                        </ButtonLink>
                      )}
                    </Show>
                  );
                }}
              </Show>
              <Show when={page()}>
                {(href) => (
                  <ButtonLink href={`${href()}?tab=runs`} size="sm" variant="ghost">
                    <i class="ti ti-list-details" aria-hidden="true" />
                    {t().codeVersionRuns}
                  </ButtonLink>
                )}
              </Show>
            </div>
          </Show>
        </div>
      </Match>
      <Match when={(preview()?.latest ?? 0) > props.number}>
        <p class="assistant-code-version__line" data-state="superseded">
          <i class="ti ti-history" aria-hidden="true" />
          {t().codeVersionSuperseded({ version: props.number, latest: preview()?.latest ?? props.number })}
        </p>
      </Match>
      <Match when={preview()}>
        {(current) => (
          <div class="assistant-code-version" data-state="ready">
            <p class="assistant-code-version__title">
              <FeatCodeMark variant="glyph" decorative class="assistant-code-version__mark" />
              {t().codeVersionReady({ version: props.number, title: current().title })}
            </p>
            <Show when={current().automations?.length}>
              <p class="assistant-code-version__note">
                {current()
                  .automations?.map((entry) => entry.title ?? entry.entrypoint)
                  .join(" · ")}
              </p>
            </Show>
            <p class="assistant-code-version__note">
              {current().ownerKind === "person" ? t().codeVersionRunsAsYou : t().codeVersionRunsAsAccount}
            </p>
            <Show when={current().targets}>
              {(targets) => (
                <div class="assistant-code-version__targets">
                  <p class="assistant-code-version__label">{t().codeVersionTargets}</p>
                  <Show when={targets().length > 0} fallback={<p class="assistant-code-version__note">{t().codeVersionNoTargets}</p>}>
                    <ul class="assistant-code-version__list">
                      <For each={targets()}>
                        {(row) => (
                          <li class="assistant-code-version__target">
                            <i
                              class={
                                row.target?.icon ??
                                (!row.target ? "ti ti-arrows-shuffle" : row.target.own ? "ti ti-home" : "ti ti-target-arrow")
                              }
                              aria-hidden="true"
                            />
                            <span class="assistant-code-version__calls">
                              <Show when={row.operations.length > 0}>
                                <span class="assistant-code-version__ops">
                                  <For each={row.operations}>{(operation) => <code>{operation}</code>}</For>
                                </span>
                              </Show>
                              <span class="assistant-code-version__where">
                                {row.target ? targetLabel(row.target, current().place?.title ?? null) : t().codeVersionDynamicTarget}
                              </span>
                            </span>
                            <Show when={row.isNew}>
                              <span class="assistant-code-version__new">{pageT().newAccess}</span>
                            </Show>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </div>
              )}
            </Show>
            <Show when={current().readiness.state === "approval_pending"}>
              <p class="assistant-code-version__note">
                <i class="ti ti-hourglass" aria-hidden="true" />
                <span>
                  {t().codeVersionApprovalPending} {t().codeVersionKeepsRunning({ version: current().running })}
                </span>
              </p>
            </Show>
            <Show when={refusedMessage()}>
              {(message) => (
                <p class="assistant-code-version__note">
                  <i class="ti ti-alert-triangle" aria-hidden="true" />
                  <span>{message()}</span>
                </p>
              )}
            </Show>
            <Show when={notAllowed()}>
              {(reason) => (
                <p class="assistant-code-version__note">
                  <i class="ti ti-device-mobile-off" aria-hidden="true" />
                  <span>{reason() === "phone" ? t().codeVersionPhone : t().codeVersionCredential}</span>
                </p>
              )}
            </Show>
            <Show when={progressText()}>
              {(text) => (
                <p class="assistant-code-version__note" role="status">
                  <Show when={busy()}>
                    <i class="ti ti-loader-2 animate-spin" aria-hidden="true" />
                  </Show>
                  <span>{text()}</span>
                </p>
              )}
            </Show>
            <Show when={failedReason()}>
              {(failed) => (
                <p class="assistant-code-version__note text-danger" role="alert">
                  <i class="ti ti-alert-triangle" aria-hidden="true" />
                  <span>
                    {failed().reason ?? t().codeVersionFailed} {t().codeVersionNothingChanged({ version: current().running })}
                  </span>
                </p>
              )}
            </Show>
            <div class="assistant-code-version__actions">
              <Show when={current().readiness.state === "ready"}>
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  disabled={!current().allowed.allowed || busy()}
                  loading={spinning()}
                  onClick={() => void (activation().kind === "unknown" ? check() : start())}
                >
                  <i class="ti ti-power" aria-hidden="true" />
                  {activation().kind === "unknown"
                    ? t().codeVersionCheckStatus
                    : activation().kind === "failed"
                      ? t().codeVersionTryAgain
                      : t().codeVersionSwitchOn}
                </Button>
              </Show>
              {diffLink()}
            </div>
          </div>
        )}
      </Match>
    </Switch>
  );
}
