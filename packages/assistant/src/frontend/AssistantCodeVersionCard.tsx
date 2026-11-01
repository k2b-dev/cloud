import { Button, ButtonLink, Skeleton, Tag, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import {
  type CodeVersionActivation,
  type CodeVersionPreviewRow,
  codeVersionPageHref,
  loadCodeVersionPreview,
  pendingCodeVersionActivation,
  readCodeVersionActivation,
  startCodeVersionActivation,
} from "./code-activation";
import { formatCodeTime } from "./code-client";
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
 * The version a chat saved: what it needs at each target and whether this person can switch it on, known before they
 * click. Someone who cannot gets a link for someone who can. Once switched on, the card is one line; a reload reads the
 * same state from Core, so it never offers something already done.
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
  const [loaded, setLoaded] = createSignal<Loaded>(null);
  const [activation, setActivation] = createSignal<Activation>({ kind: "idle" });
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const load = async () => {
    setLoaded(null);
    setLoaded(await loadCodeVersionPreview(props.codeId, props.versionId));
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
  const blockedRows = () => preview()?.rows.filter((row) => row.check === "blocked") ?? [];
  const managers = () => {
    const seen = new Map<string, CodeVersionPreviewRow["managers"][number]>();
    for (const row of blockedRows()) for (const manager of row.managers) seen.set(manager.name, manager);
    return [...seen.values()];
  };
  const blockedText = () => {
    const rows = blockedRows();
    // A target the person may not read stays an ID, with no name of who manages it.
    const unreadable = rows.find((row) => row.title === null);
    if (unreadable) return t().codeVersionTargetUnreadable({ id: unreadable.target.id });
    const types = [
      ...new Set(
        preview()
          ?.rows.filter((row) => row.check === "blocked" || row.own)
          .flatMap((row) => row.typeTitle ?? []) ?? [],
      ),
    ];
    const joined = new Intl.ListFormat(locale(), { style: "long", type: "conjunction" }).format(types);
    if (types.length === 0) return t().codeVersionManagersGeneric;
    const names = managers().map((manager) => manager.name);
    return names.length > 0
      ? t().codeVersionManagers({ types: joined, names: names.join(", ") })
      : t().codeVersionManagersUnnamed({ types: joined });
  };
  const copyLabel = () => {
    const [only, ...others] = managers();
    return only && others.length === 0 ? t().codeVersionCopyLinkFor({ name: only.firstName ?? only.name }) : t().codeVersionCopyLink;
  };
  const copyLink = async (href: string) => {
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.origin).href);
      toast.success(t().codeVersionLinkCopied);
    } catch {
      toast.error(t().codeVersionLinkFailed);
    }
  };
  const targetLine = (row: CodeVersionPreviewRow) => {
    const type = row.typeTitle ?? (row.own ? preview()?.place?.typeTitle : null);
    if (row.own && type) return t().codeVersionOwnTarget({ type });
    if (row.target.type === "app") return row.title ?? row.target.id;
    if (!row.title) return t().codeVersionTargetId({ id: row.target.id });
    return t().codeVersionTarget({ name: type ? `${type} ${row.title}` : row.title, id: row.target.id });
  };
  const rowState = (row: CodeVersionPreviewRow): JSX.Element => {
    if (row.check === "blocked")
      return (
        <span class="text-danger">
          <i class="ti ti-lock" aria-hidden="true" /> {t().codeVersionNeedsAdmin({ name: row.title })}
        </span>
      );
    if (row.own) return <span class="text-secondary">{t().codeVersionBelongsTo({ name: preview()?.place?.title ?? "" })}</span>;
    if (row.check === "manages")
      return (
        <span class="assistant-code-version__ok">
          <i class="ti ti-check" aria-hidden="true" /> {t().codeVersionYouManage}
        </span>
      );
    if (row.check === "has") return <span class="text-secondary">{t().codeVersionHas({ version: preview()?.running ?? null })}</span>;
    return <span class="text-secondary">{t().codeVersionUnchecked}</span>;
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
          <div class="assistant-code-version__row">
            <Skeleton class="h-4 w-4 rounded" />
            <Skeleton class="h-3 w-4/5" />
          </div>
          <div class="assistant-code-version__row">
            <Skeleton class="h-4 w-4 rounded" />
            <Skeleton class="h-3 w-2/3" />
          </div>
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
      </Match>
      <Match when={(preview()?.latest ?? 0) > props.number}>
        <p class="assistant-code-version__line" data-state="superseded">
          <i class="ti ti-history" aria-hidden="true" />
          {t().codeVersionSuperseded({ version: props.number, latest: preview()?.latest ?? props.number })}
        </p>
      </Match>
      <Match when={preview()}>
        {(current) => (
          <div class="assistant-code-version" data-state={blockedRows().length > 0 ? "blocked" : "ready"}>
            <p class="assistant-code-version__title">{t().codeVersionReady({ version: props.number, title: current().title })}</p>
            <Show
              when={current().rows.length > 0}
              fallback={
                <Show when={!current().place}>
                  <p class="assistant-code-version__note">{t().codeVersionRunsAsYou}</p>
                </Show>
              }
            >
              <ul class="m-0 list-none p-0">
                <For each={current().rows}>
                  {(row) => (
                    <li class="assistant-code-version__row" data-check={row.check}>
                      <i class={row.icon ?? (row.own ? "ti ti-home" : "ti ti-target-arrow")} aria-hidden="true" />
                      <span class="flex min-w-0 flex-col">
                        <Show when={row.operations.length > 0}>
                          <span class="assistant-code-version__ops">
                            <For each={row.operations}>{(operation) => <code>{operation}</code>}</For>
                          </span>
                        </Show>
                        <span class="text-sm text-secondary">{targetLine(row)}</span>
                      </span>
                      <span class="assistant-code-version__state">
                        <Show when={row.isNew}>
                          <Tag>{t().codeVersionNew}</Tag>
                        </Show>
                        {rowState(row)}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
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
            <Show when={blockedRows().length > 0}>
              <p class="assistant-code-version__note">
                <i class="ti ti-info-circle" aria-hidden="true" />
                <span>
                  {blockedText()} {t().codeVersionKeepsRunning({ version: current().running })}
                </span>
              </p>
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
              <Show
                when={blockedRows().length === 0}
                fallback={
                  <Show when={codeVersionPageHref(current())}>
                    {(href) => (
                      <Button type="button" size="sm" variant="secondary" onClick={() => void copyLink(href())}>
                        <i class="ti ti-link" aria-hidden="true" />
                        {copyLabel()}
                      </Button>
                    )}
                  </Show>
                }
              >
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
              </Show>
              {diffLink()}
            </div>
          </div>
        )}
      </Match>
    </Switch>
  );
}
