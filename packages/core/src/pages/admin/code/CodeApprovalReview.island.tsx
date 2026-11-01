import { Button, ButtonLink, CodeDiff, type CodeDiffLocation, NoticeCard, prompts, useLocale } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { type CodeVersionBinding, type CodeVersionDiffFile, codeVersionContracts } from "../../../code/version-contracts";
import { CodeAdminRequestError, postCodeAdmin, reloadCodeArea } from "./client";
import { codeAdminMessages } from "./messages";

/** One permission row, already labelled by the page. `side` is old for a removed permission. */
export type CodeApprovalRight = {
  icon: string;
  label: string;
  sub: string;
  change: "added" | "same" | "removed";
  file?: string;
  line?: number;
};

export type CodeApprovalReviewProps = {
  number: number;
  binding: CodeVersionBinding;
  status: "submitted" | "pending" | "approved" | "rejected" | "expired" | "cancelled";
  canApprove: boolean;
  own: boolean;
  soleAdminNotice: string | null;
  staleComparison: boolean;
  newer: { number: number; author: string; href: string } | null;
  why: string[];
  rights: CodeApprovalRight[];
  internet: string[];
  diffHeader: string;
  files: CodeVersionDiffFile[] | null;
  decision: { approved: boolean; soleAdmin: boolean; by: string; when: string } | null;
  /** The Code in Administration › Code, where it can be paused. */
  codeHref: string;
  nextHref: string | null;
  listHref: string;
};

const short = (hash: string | null) => (hash ? `${hash.slice(0, 4)}…${hash.slice(-2)}` : "—");

/**
 * The detail level of one version: why it needs you, what changes in permissions, the full Code difference and the
 * decision bound to the exact hashes. Deciding sends the unchanged binding; the server rechecks everything.
 */
export default function CodeApprovalReview(props: CodeApprovalReviewProps) {
  const locale = useLocale();
  const t = () => codeAdminMessages.resolve([locale()]).t;
  const [mark, setMark] = createSignal<CodeDiffLocation>();
  const [busy, setBusy] = createSignal<"approve" | "reject" | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [done, setDone] = createSignal<"approved" | "rejected" | null>(null);
  let diffRegion: HTMLElement | undefined;

  const pending = () => props.status === "pending" && !done();
  const blocked = () => (props.newer ? t().outdated({ n: props.number }) : props.files ? null : t().notLoaded);
  const mayDecide = () => pending() && props.canApprove && !props.staleComparison;

  const decide = async (approved: boolean) => {
    if (!approved) {
      const confirmed = await prompts.confirm(t().rejectBody, {
        title: t().rejectTitle({ n: props.number }),
        confirmText: t().rejectConfirm,
        cancelText: t().cancel,
        variant: "danger",
      });
      if (!confirmed) return;
    }
    setBusy(approved ? "approve" : "reject");
    setFailure(null);
    try {
      const result = await postCodeAdmin("decide", { binding: props.binding, approved }, codeVersionContracts.decide.data);
      setDone(result.status === "approved" ? "approved" : result.status === "rejected" ? "rejected" : null);
      // The server renders the decision and the sidebar count of open approvals from the same state.
      reloadCodeArea();
    } catch (error) {
      // Only a refusal proves nothing changed; a lost answer may follow a committed decision.
      setFailure(
        !(error instanceof CodeAdminRequestError) || error.status < 400 || error.status >= 500
          ? `${t().unknownTitle} ${t().unknownDecideSub}`
          : error.status === 409
            ? t().decideConflict
            : error.status === 403
              ? t().decideForbidden
              : t().decideFailed,
      );
    } finally {
      setBusy(null);
    }
  };

  const showLine = (right: CodeApprovalRight) => {
    if (!right.file || !right.line) return;
    setMark({ path: right.file, line: right.line, side: right.change === "removed" ? "old" : "new" });
    diffRegion?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const decidedNotice = () => {
    const state = done() ?? (props.status === "approved" || props.status === "rejected" ? props.status : null);
    if (!state) return null;
    return (
      <NoticeCard
        tone={state === "approved" ? "success" : "neutral"}
        title={state === "approved" ? t().approvedTitle({ n: props.number }) : t().rejectedTitle({ n: props.number })}
        detail={
          <>
            <p>{state === "approved" ? `${t().approvedSub} ${t().undoHint}` : t().rejectedSub}</p>
            <Show when={!done() && props.decision}>
              {(decision) => (
                <p class="text-(--k2b-text-muted)">
                  {t().decidedBy({ who: decision().by, when: decision().when })}
                  {decision().soleAdmin ? ` · ${t().selfApproved}` : ""}
                </p>
              )}
            </Show>
            <div class="mt-2 flex flex-wrap gap-2">
              <Show when={state === "approved"}>
                <ButtonLink size="sm" variant="secondary" href={props.codeHref}>
                  {t().openCode}
                </ButtonLink>
              </Show>
              <Show
                when={props.nextHref}
                fallback={
                  <ButtonLink size="sm" variant="secondary" href={props.listHref}>
                    {t().backToList}
                  </ButtonLink>
                }
              >
                {(href) => (
                  <ButtonLink size="sm" href={href()}>
                    {t().nextVersion}
                  </ButtonLink>
                )}
              </Show>
            </div>
          </>
        }
      />
    );
  };

  return (
    <div class="flex min-h-full flex-col">
      <div class="grid flex-1 content-start gap-6 px-2 pt-1 pb-6">
        <Show when={decidedNotice()}>{(notice) => notice()}</Show>

        <Show when={!done() && (props.status === "expired" || props.status === "cancelled")}>
          <NoticeCard tone="neutral" title={t().closedTitle} detail={t().closedSub} />
        </Show>
        <Show when={pending() && props.newer}>
          {(newer) => (
            <NoticeCard
              tone="warning"
              icon="ti ti-git-branch"
              title={t().newerTitle({ who: newer().author, n: newer().number })}
              detail={
                <>
                  <p>{t().newerSub({ n: props.number })}</p>
                  <div class="mt-2">
                    <ButtonLink size="sm" href={newer().href}>
                      {t().reviewNewer({ n: newer().number })}
                    </ButtonLink>
                  </div>
                </>
              }
            />
          )}
        </Show>
        <Show when={pending() && !props.newer && props.staleComparison}>
          <NoticeCard tone="warning" title={t().staleTitle} detail={t().staleSub} />
        </Show>
        <Show when={pending() && props.own && !props.soleAdminNotice}>
          <NoticeCard tone="neutral" icon="ti ti-user-x" title={t().ownTitle} detail={t().ownSub} />
        </Show>
        <Show when={pending() && props.soleAdminNotice}>
          {(notice) => <NoticeCard tone="warning" icon="ti ti-user-shield" title={t().soleTitle} detail={notice()} />}
        </Show>
        <Show when={failure()}>
          {(message) => (
            <NoticeCard
              tone="danger"
              title={message()}
              detail={
                <div class="mt-1">
                  <Button size="sm" variant="secondary" onClick={() => reloadCodeArea()}>
                    <i class="ti ti-refresh" aria-hidden="true" />
                    {t().reload}
                  </Button>
                </div>
              }
            />
          )}
        </Show>

        <section class="grid gap-2" aria-labelledby="code-review-why">
          <h3 id="code-review-why" class="text-base font-semibold">
            {t().why}
          </h3>
          <Show when={props.why.length} fallback={<p class="text-sm text-(--k2b-text-muted)">{t().whyNone}</p>}>
            <ul class="grid gap-2">
              <For each={props.why}>
                {(line) => (
                  <li class="flex items-start gap-3 text-sm">
                    <i class="ti ti-user-shield mt-0.5 text-(--k2b-text-muted)" aria-hidden="true" />
                    <span>{line}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <section class="grid gap-2" aria-labelledby="code-review-rights">
          <div class="flex items-baseline justify-between gap-3">
            <h3 id="code-review-rights" class="text-base font-semibold">
              {t().rights}
            </h3>
            <span class="text-xs text-(--k2b-text-muted)">{t().rightsSub}</span>
          </div>
          <Show when={props.rights.length} fallback={<p class="text-sm text-(--k2b-text-muted)">{t().noRights}</p>}>
            <ul class="grid gap-1">
              <For each={props.rights}>
                {(right) => (
                  <li
                    class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm"
                    classList={{ "bg-(--k2b-success-surface)": right.change === "added" }}
                    data-change={right.change}
                  >
                    <i
                      class={`ti ${right.change === "added" ? "ti-plus text-(--k2b-success-text)" : right.change === "removed" ? "ti-minus text-(--k2b-text-muted)" : right.icon}`}
                      aria-hidden="true"
                    />
                    <span class="min-w-0 flex-1" classList={{ "line-through text-(--k2b-text-muted)": right.change === "removed" }}>
                      <span class="font-medium">{right.label}</span>
                      <span class="block text-xs text-(--k2b-text-muted)">{right.sub}</span>
                    </span>
                    <span class="shrink-0 text-xs text-(--k2b-text-muted)">
                      {right.change === "added" ? t().changeAdded : right.change === "removed" ? t().changeRemoved : t().changeSame}
                    </span>
                    <Show when={right.file && right.line && props.files}>
                      <button
                        type="button"
                        class="k2b-link shrink-0 font-mono text-xs"
                        aria-label={t().showLine({ file: right.file ?? "", n: right.line ?? 0 })}
                        onClick={() => showLine(right)}
                      >
                        {t().lineRef({ n: right.line ?? 0 })}
                      </button>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <section class="grid gap-2" aria-labelledby="code-review-internet">
          <div class="flex items-baseline justify-between gap-3">
            <h3 id="code-review-internet" class="text-base font-semibold">
              {t().internetOrigins}
            </h3>
            <span class="text-xs text-(--k2b-text-muted)">{t().internetSub}</span>
          </div>
          <Show
            when={props.internet.length}
            fallback={<p class="text-sm text-(--k2b-text-muted)">{t().internetNone}</p>}
          >
            <ul class="grid gap-1">
              <For each={props.internet}>
                {(target) => (
                  <li class="flex items-center gap-3 px-3 py-1 text-sm">
                    <i class="ti ti-world text-(--k2b-text-muted)" aria-hidden="true" />
                    <span class="min-w-0 flex-1">
                      <span class="font-mono">{target}</span>
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <section class="grid gap-2" aria-labelledby="code-review-diff" ref={diffRegion}>
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 id="code-review-diff" class="text-base font-semibold">
              {t().diff}
            </h3>
            <span class="text-xs text-(--k2b-text-muted)">{props.diffHeader}</span>
          </div>
          <CodeDiff
            files={props.files ?? []}
            mark={mark()}
            status={props.files ? undefined : "error"}
            errorDescription={t().diffFailedSub}
            onRetry={() => reloadCodeArea()}
            label={t().diff}
          />
        </section>
      </div>

      <div class="sticky bottom-0 flex flex-wrap items-center gap-2 bg-(--k2b-surface) px-2 py-3">
        <span class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-(--k2b-text-muted)">
          <i class="ti ti-lock" aria-hidden="true" />
          <span>{t().boundTo({ n: props.number })}</span>
          <span class="hidden md:inline">
            · {t().sourceHash} <code title={props.binding.sourceHash}>{short(props.binding.sourceHash)}</code> · {t().bundleHash}{" "}
            <code title={props.binding.bundleHash}>{short(props.binding.bundleHash)}</code>
          </span>
        </span>
        <Show when={pending() && (!props.own || props.soleAdminNotice)}>
          <Button
            variant="secondary"
            disabled={!mayDecide() || busy() !== null}
            loading={busy() === "reject"}
            onClick={() => void decide(false)}
          >
            {t().reject}
          </Button>
          <Show when={blocked() ?? (props.staleComparison ? t().staleTitle : null)}>
            {(reason) => (
              <span class="text-xs font-medium text-(--k2b-warning-text)">
                <i class="ti ti-alert-triangle" aria-hidden="true" /> {reason()}
              </span>
            )}
          </Show>
          <Button
            disabled={!mayDecide() || blocked() !== null || busy() !== null}
            loading={busy() === "approve"}
            onClick={() => void decide(true)}
          >
            <i class="ti ti-check" aria-hidden="true" />
            {t().approveVersion({ n: props.number })}
          </Button>
        </Show>
      </div>
    </div>
  );
}
