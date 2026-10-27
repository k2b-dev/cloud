import {
  Avatar,
  Button,
  ButtonLink,
  ChoiceChips,
  CodeDisplay,
  IconButton,
  Skeleton,
  TextInput,
  type ToastHandle,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, type JSX, Match, onCleanup, Show, Switch } from "solid-js";
import {
  formatKeptEffects,
  formatLogReasons,
  formatLogTime,
  formatLogTitle,
  type LogReasonPart,
  undoRevertedAssignment,
} from "./mail-automation-log-format";
import { type MailAutomationLogText, mailAutomationLogMessages } from "./mail-automation-log-messages";
import type {
  AuditStep,
  AutomationLogDetail,
  AutomationLogFilter,
  AutomationLogItem,
  AutomationLogPage,
} from "./mail-automation-log-model";

export type MailAutomationLogApi = {
  load: (params: { filter: AutomationLogFilter; q: string; before: string | null }, signal: AbortSignal) => Promise<AutomationLogPage>;
  detail: (id: string, signal: AbortSignal) => Promise<AutomationLogDetail>;
  /** Resolves with the updated item; rejects with `UndoNotPossible` when someone changed the assignment since. */
  undo: (id: string) => Promise<AutomationLogItem>;
  redo: (id: string) => Promise<AutomationLogItem>;
};

/** The server refused Undo because the effect is no longer current; the item says why. */
export class UndoNotPossible extends Error {
  constructor(readonly item: AutomationLogItem) {
    super("undo_not_possible");
  }
}

const FILTERS: AutomationLogFilter[] = ["all", "assignments", "uncertain", "skipped", "manual"];
const COLUMNS = "grid-cols-[4rem_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.7fr)_7.5rem]";
const COLUMNS_WITH_DETAIL = "grid-cols-[4rem_minmax(0,1.1fr)_minmax(0,1.7fr)_2rem]";
const SKELETON_ROWS = 8;
/** On phones a row stacks: who and time, the conversation, what happened, the action. */
const ROW_PHONE =
  "max-md:grid-cols-[minmax(0,1fr)_auto] max-md:py-2.5 max-md:[grid-template-areas:'by_time''conv_conv''what_what''act_act']";
/** Pasting must never run anything: plain words stay bare, everything else is single-quoted for POSIX shells. */
const shellQuote = (value: string) => (/^[A-Za-z0-9_./:@%+=-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`);

function Reasons(props: { parts: LogReasonPart[]; struck?: boolean }) {
  const locale = useLocale();
  const t = createMemo(() => mailAutomationLogMessages.resolve([locale()]).t);
  return (
    <span class="block text-xs text-dimmed" classList={{ "line-through": props.struck }}>
      <For each={props.parts}>
        {(part, index) => (
          <>
            {index() > 0 ? " · " : ""}
            {part.text}
            <Show when={part.ai}>
              <i class="ti ti-sparkles ml-0.5 text-[color:var(--k2b-ai-accent)]" aria-hidden="true" />
              <span class="sr-only"> ({t().aiMark})</span>
            </Show>
          </>
        )}
      </For>
    </span>
  );
}

export default function MailAutomationLog(props: {
  mailboxName: string;
  timeZone?: string;
  initial: AutomationLogPage;
  initialFilter?: AutomationLogFilter;
  initialQuery?: string;
  /** An entry opened from elsewhere (the reader's "Why?"), rendered with its chain on the server. */
  initialDetail?: AutomationLogDetail | null;
  canUndo: boolean;
  api: MailAutomationLogApi;
  /** Keeps the filter, search and open entry in the URL, so reload and back return to the same view. */
  onViewChange?: (view: { filter: AutomationLogFilter; q: string; entry: string | null }) => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailAutomationLogMessages.resolve([locale()]).t);
  const [filter, setFilter] = createSignal<AutomationLogFilter>(props.initialFilter ?? "all");
  const [query, setQuery] = createSignal(props.initialQuery ?? "");
  const [searchOpen, setSearchOpen] = createSignal(!!props.initialQuery);
  const [page, setPage] = createSignal<AutomationLogPage>(props.initial);
  const [phase, setPhase] = createSignal<"ready" | "loading" | "error">("ready");
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [selected, setSelected] = createSignal<string | null>(props.initialDetail?.id ?? null);
  const [detail, setDetail] = createSignal<AutomationLogDetail | null>(props.initialDetail ?? null);
  const [detailError, setDetailError] = createSignal(false);
  const [notPossible, setNotPossible] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [cliOpen, setCliOpen] = createSignal(false);
  const notices = new Set<ToastHandle>();
  /** Keeps at most the three newest handles, like the toast rail itself. */
  const keepNotice = (notice: ToastHandle) => {
    notices.add(notice);
    for (const older of notices) {
      if (notices.size <= 3) break;
      notices.delete(older);
    }
  };
  let controller: AbortController | null = null;
  let moreController: AbortController | null = null;
  let detailController: AbortController | null = null;
  /** Grows with every filter or search change; an older page only joins the view it was asked for. */
  let viewVersion = 0;
  let disposed = false;
  let detailHeading: HTMLHeadingElement | undefined;
  let detailTrigger: string | null = null;
  onCleanup(() => {
    disposed = true;
    controller?.abort();
    moreController?.abort();
    detailController?.abort();
    for (const notice of notices) notice.dismiss();
  });
  const report = () => props.onViewChange?.({ filter: filter(), q: query(), entry: selected() });
  /** Moves focus to the row's own button after the row changed or a detail closed. */
  const focusRow = (id: string | null) =>
    id && queueMicrotask(() => document.querySelector<HTMLElement>(`[data-log-row="${CSS.escape(id)}"] [data-log-open]`)?.focus());

  const reload = async () => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    setPhase("loading");
    try {
      const next = await props.api.load({ filter: filter(), q: query().trim(), before: null }, current.signal);
      if (current.signal.aborted) return;
      setPage(next);
      setPhase("ready");
    } catch {
      if (!current.signal.aborted) setPhase("error");
    }
  };
  const changeView = (patch: { filter?: AutomationLogFilter; q?: string }) => {
    viewVersion += 1;
    moreController?.abort();
    moreController = null;
    setLoadingMore(false);
    if (patch.filter !== undefined) setFilter(patch.filter);
    if (patch.q !== undefined) setQuery(patch.q);
    report();
    void reload();
  };
  const loadOlder = async () => {
    const cursor = page().nextCursor;
    if (!cursor || loadingMore()) return;
    const version = viewVersion;
    const current = new AbortController();
    moreController = current;
    setLoadingMore(true);
    try {
      const next = await props.api.load({ filter: filter(), q: query().trim(), before: cursor }, current.signal);
      if (current.signal.aborted || version !== viewVersion) return;
      setPage((page) => ({ ...next, items: [...page.items, ...next.items] }));
    } catch {
      if (current.signal.aborted || version !== viewVersion || disposed) return;
      keepNotice(toast.error(t().errorTitle, { action: { label: t().retry, onClick: () => void loadOlder() } }));
    } finally {
      if (moreController === current) {
        moreController = null;
        setLoadingMore(false);
      }
    }
  };
  /** One entry changed: the list row and an open detail show the same state. */
  const replaceItem = (item: AutomationLogItem) => {
    setPage((current) => ({ ...current, items: current.items.map((candidate) => (candidate.id === item.id ? item : candidate)) }));
    if (detail()?.id === item.id) setDetail((current) => (current ? { ...current, ...item } : current));
  };

  const openDetail = async (id: string) => {
    detailController?.abort();
    const current = new AbortController();
    detailController = current;
    detailTrigger = id;
    setSelected(id);
    setDetail(null);
    setDetailError(false);
    report();
    try {
      const value = await props.api.detail(id, current.signal);
      if (current.signal.aborted) return;
      setDetail(value);
      // The trigger may be hidden now (phone), so focus moves to the detail it opened.
      queueMicrotask(() => detailHeading?.focus());
    } catch {
      if (!current.signal.aborted) setDetailError(true);
    }
  };
  const closeDetail = () => {
    detailController?.abort();
    setSelected(null);
    setDetail(null);
    report();
    focusRow(detailTrigger);
  };

  const undo = async (item: AutomationLogItem) => {
    if (busy()) return;
    setBusy(item.id);
    setNotPossible(null);
    try {
      const updated = await props.api.undo(item.id);
      replaceItem(updated);
      if (!selected()) focusRow(item.id);
      if (disposed) return;
      const message = undoRevertedAssignment(updated) ? t().undoneToast : t().undoneEffectsToast;
      const notice = toast(message({ subject: item.conversation.subject }), {
        action: {
          label: t().redo,
          onClick: () => {
            notice.dismiss();
            void redo(updated);
          },
        },
      });
      keepNotice(notice);
    } catch (error) {
      if (error instanceof UndoNotPossible) {
        replaceItem(error.item);
        setNotPossible(item.id);
        if (!selected()) focusRow(item.id);
      } else if (!disposed) {
        const notice = toast.error(t().undoFailed, {
          action: {
            label: t().retry,
            onClick: () => {
              notice.dismiss();
              void undo(item);
            },
          },
        });
        keepNotice(notice);
      }
    } finally {
      setBusy(null);
    }
  };
  const redo = async (item: AutomationLogItem) => {
    try {
      replaceItem(await props.api.redo(item.id));
      setNotPossible(null);
    } catch (error) {
      if (error instanceof UndoNotPossible) replaceItem(error.item);
      if (!disposed) keepNotice(toast.error(t().redoFailed));
    }
  };

  const filterLabel = (value: AutomationLogFilter) =>
    ({
      all: t().filterAll,
      assignments: t().filterAssignments,
      uncertain: t().filterUncertain,
      skipped: t().filterSkipped,
      manual: t().filterManual,
    })[value];
  const cliCommands = () => {
    const mailbox = `--mailbox ${shellQuote(props.mailboxName)}`;
    const parts = ["cld mail automation log", mailbox, `--day ${page().day}`];
    if (filter() !== "all") parts.push(`--filter ${filter()}`);
    if (query().trim()) parts.push(`--q ${shellQuote(query().trim())}`);
    return [parts.join(" "), `cld mail automation log show <id> ${mailbox}`, `cld mail automation log undo <id> ${mailbox}`].join("\n");
  };
  const olderCount = () => page().counts[filter()] - page().items.length;
  const time = (iso: string) => formatLogTime(iso, locale(), props.timeZone);
  const columns = () => (selected() ? COLUMNS_WITH_DETAIL : COLUMNS);

  const byCell = (item: AutomationLogItem): JSX.Element => {
    const by = item.by;
    return by.kind === "rule" ? (
      <span class="flex min-w-0 items-center gap-1.5 text-[0.8125rem] max-md:text-xs">
        <i class="ti ti-bolt text-dimmed" aria-hidden="true" />
        <span class="min-w-0 truncate">
          <span class="font-medium">{t().rule}</span> · {by.name}
        </span>
        <Show when={by.ai}>
          <i class="ti ti-sparkles text-[color:var(--k2b-ai-accent)]" aria-hidden="true" />
        </Show>
      </span>
    ) : (
      <span class="flex min-w-0 items-center gap-1.5 text-[0.8125rem]">
        <Avatar name={by.name} size="xs" />
        <span class="min-w-0 truncate">{by.name}</span>
      </span>
    );
  };
  const actionCell = (item: AutomationLogItem): JSX.Element => (
    <Switch fallback={<span class="text-dimmed">—</span>}>
      <Match when={item.undo.state === "done"}>
        <span class="flex flex-col text-xs text-dimmed">
          <span>{t().undone({ time: item.undo.at ? time(item.undo.at) : "" })}</span>
          <Show when={formatKeptEffects(item, t())}>{(kept) => <span>{kept()}</span>}</Show>
        </span>
      </Match>
      <Match when={item.undo.state === "not_possible" && item.undo.reason === "provider_pending" && props.canUndo}>
        <Button size="sm" variant="secondary" disabled={busy() === item.id} onClick={() => void undo(item)}>
          <i class="ti ti-refresh" aria-hidden="true" /> {t().retry}
        </Button>
      </Match>
      <Match when={item.undo.state === "not_possible" && item.undo.by}>
        <span class="text-xs text-dimmed">{t().staysWith({ name: item.undo.by!.name })}</span>
      </Match>
      <Match when={item.undo.state === "available" && props.canUndo}>
        <Button size="sm" variant="secondary" disabled={busy() === item.id} onClick={() => void undo(item)}>
          <i class="ti ti-arrow-back-up" aria-hidden="true" /> {t().undo}
        </Button>
      </Match>
    </Switch>
  );

  return (
    <div class="flex min-h-0 min-w-0 flex-1 gap-6" data-mail-automation-log>
      <section class="flex min-w-0 flex-1 flex-col gap-2" classList={{ "max-md:hidden": selected() !== null }}>
        <header class="flex min-h-9 flex-wrap items-center gap-x-2.5 gap-y-1">
          <h1 class="text-lg font-semibold text-primary">{t().title}</h1>
          <span class="text-[0.8125rem] text-dimmed">{t().today({ mailbox: props.mailboxName })}</span>
          <span class="flex-1" />
          <Tooltip.Anchor content={t().search}>
            <IconButton
              size="sm"
              variant="ghost"
              label={t().search}
              aria-expanded={searchOpen()}
              onClick={() => setSearchOpen(!searchOpen())}
            >
              <i class="ti ti-search" aria-hidden="true" />
            </IconButton>
          </Tooltip.Anchor>
          <Button size="sm" variant="ghost" aria-expanded={cliOpen()} onClick={() => setCliOpen(!cliOpen())}>
            <i class="ti ti-code" aria-hidden="true" /> {t().asCli}
          </Button>
        </header>
        <Show when={searchOpen()}>
          <TextInput
            aria-label={t().search}
            placeholder={t().searchPlaceholder}
            value={query}
            onValueChange={setQuery}
            onValueCommit={(value) => changeView({ q: value })}
            type="search"
          />
        </Show>
        <Show when={cliOpen()}>
          <div class="flex flex-col gap-1.5" data-mail-automation-log-cli>
            <p class="text-xs text-dimmed">{t().cliDescription}</p>
            <CodeDisplay code={cliCommands()} language="text" title={t().cliTitle} />
          </div>
        </Show>
        <ChoiceChips
          aria-label={t().filters}
          value={filter()}
          onValueChange={(value) => changeView({ filter: value })}
          options={FILTERS.map((value) => ({
            value,
            label: value === "all" ? filterLabel(value) : `${filterLabel(value)} ${page().counts[value]}`,
            icon: value === "uncertain" ? "ti ti-sparkles" : undefined,
          }))}
        />

        <div role="table" aria-label={t().title} aria-busy={phase() === "loading"} class="flex min-w-0 flex-col">
          <div role="row" class={`grid ${columns()} gap-3 px-2 pb-1 text-xs font-semibold text-secondary max-md:sr-only`}>
            <span role="columnheader">{t().colTime}</span>
            <span role="columnheader">{t().colConversation}</span>
            <Show when={!selected()}>
              <span role="columnheader">{t().colBy}</span>
            </Show>
            <span role="columnheader">{t().colWhat}</span>
            <span role="columnheader" class="sr-only">
              {t().undo}
            </span>
          </div>
          <Switch>
            <Match when={phase() === "loading"}>
              <For each={Array.from({ length: SKELETON_ROWS }, (_, index) => index)}>
                {() => (
                  // Same grid and areas as a loaded row, so loading → ready moves nothing on any width.
                  <div
                    class={`grid ${columns()} min-h-14 items-center gap-x-3 gap-y-1.5 px-2 py-1.5 ${ROW_PHONE} max-md:min-h-[7.5rem]`}
                    aria-hidden="true"
                  >
                    <Skeleton class="h-3 w-9 rounded max-md:[grid-area:time]" />
                    <Skeleton class="h-3 w-4/5 rounded max-md:[grid-area:conv]" />
                    <Show when={!selected()}>
                      <Skeleton class="h-3 w-3/4 rounded max-md:[grid-area:by]" />
                    </Show>
                    <Skeleton class="h-3 w-11/12 rounded max-md:[grid-area:what]" />
                    <Skeleton class="h-7 w-28 rounded max-md:[grid-area:act] md:invisible" />
                  </div>
                )}
              </For>
              <span class="sr-only" role="status">
                {t().loading}
              </span>
            </Match>
            <Match when={phase() === "error"}>
              <div class="flex flex-col items-start gap-2 px-2 py-6" role="alert">
                <p class="flex items-center gap-2 text-sm font-medium text-primary">
                  <i class="ti ti-alert-triangle text-red-600 dark:text-red-400" aria-hidden="true" /> {t().errorTitle}
                </p>
                <p class="text-[0.8125rem] text-dimmed">{t().errorText}</p>
                <Button size="sm" variant="secondary" onClick={() => void reload()}>
                  <i class="ti ti-refresh" aria-hidden="true" /> {t().retry}
                </Button>
              </div>
            </Match>
            <Match when={page().items.length === 0}>
              <div class="flex flex-col items-start gap-1 px-2 py-6">
                <Show
                  when={filter() === "all" && !query().trim()}
                  fallback={
                    <>
                      <p class="text-sm text-primary">{t().emptyFilter}</p>
                      <Button size="sm" variant="ghost" onClick={() => changeView({ filter: "all", q: "" })}>
                        {t().resetFilter}
                      </Button>
                    </>
                  }
                >
                  <p class="flex items-center gap-2 text-sm text-primary">
                    <i class="ti ti-history text-dimmed" aria-hidden="true" /> {t().emptyTitle}
                  </p>
                  <p class="text-[0.8125rem] text-dimmed">{t().emptyText}</p>
                </Show>
              </div>
            </Match>
            <Match when={true}>
              <For each={page().items}>
                {(item) => {
                  const struck = () => item.undo.state === "done";
                  return (
                    <>
                      <div
                        role="row"
                        class={`relative grid ${columns()} min-h-14 items-center gap-x-3 gap-y-1 rounded-[var(--ui-radius-control)] px-2 py-1.5 text-[0.8125rem] hover:bg-[var(--ui-hover)] ${ROW_PHONE}`}
                        classList={{ "bg-[var(--ui-selected,var(--ui-hover))]": selected() === item.id }}
                        data-log-outcome={item.outcome}
                        data-log-row={item.id}
                      >
                        <time
                          role="cell"
                          class="tabular-nums text-dimmed max-md:text-right max-md:text-xs max-md:[grid-area:time]"
                          dateTime={item.at}
                        >
                          {time(item.at)}
                        </time>
                        <span role="cell" class="min-w-0 max-md:[grid-area:conv]">
                          <button
                            type="button"
                            class="block w-full min-w-0 truncate text-left font-medium text-primary after:absolute after:inset-0 after:content-['']"
                            aria-label={`${item.conversation.subject} · ${t().detail}`}
                            data-log-open
                            onClick={() => void openDetail(item.id)}
                          >
                            {item.conversation.subject}
                          </button>
                          <span class="block truncate text-xs text-dimmed max-md:hidden">
                            {item.conversation.from.name || item.conversation.from.email}
                          </span>
                        </span>
                        <Show when={!selected()}>
                          <span role="cell" class="min-w-0 max-md:text-xs max-md:text-dimmed max-md:[grid-area:by]">
                            {byCell(item)}
                          </span>
                        </Show>
                        <span role="cell" class="min-w-0 max-md:[grid-area:what]">
                          <span
                            class="block font-medium"
                            classList={{
                              "line-through text-dimmed": struck(),
                              "text-amber-700 dark:text-amber-400": item.outcome === "skipped" && !struck(),
                              "text-red-700 dark:text-red-300": item.outcome === "failed" && !struck(),
                              "text-primary": !struck() && item.outcome !== "skipped" && item.outcome !== "failed",
                            }}
                          >
                            {formatLogTitle(item, t())}
                          </span>
                          <Reasons parts={formatLogReasons(item, t(), locale())} struck={struck()} />
                        </span>
                        <span role="cell" class="relative z-[1] flex justify-end text-right max-md:justify-start max-md:[grid-area:act]">
                          <Show when={!selected()} fallback={<i class="ti ti-chevron-right text-dimmed" aria-hidden="true" />}>
                            {actionCell(item)}
                          </Show>
                        </span>
                      </div>
                      <Show when={notPossible() === item.id}>
                        <div
                          class="mx-2 mb-1 flex flex-col gap-1.5 rounded-[var(--ui-radius-control)] bg-red-50 px-3 py-2.5 text-[0.8125rem] text-red-900 dark:bg-red-950/30 dark:text-red-100"
                          role="alert"
                        >
                          <p>
                            <i class="ti ti-alert-circle mr-1.5" aria-hidden="true" />
                            <b>{t().notPossibleTitle}</b> {notPossibleText(item, t(), time)}
                          </p>
                          <Show when={item.undo.reason !== "conversation_gone"}>
                            <div>
                              <ButtonLink size="sm" variant="secondary" href={item.conversation.href}>
                                {t().openConversation}
                              </ButtonLink>
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </>
                  );
                }}
              </For>
              <Show when={page().nextCursor}>
                <div class="flex justify-center py-3">
                  <button
                    type="button"
                    class="text-[0.8125rem] font-medium text-primary underline underline-offset-4"
                    disabled={loadingMore()}
                    onClick={() => void loadOlder()}
                  >
                    {olderCount() > 0 ? t().olderCount({ count: olderCount() }) : t().older}
                  </button>
                </div>
              </Show>
            </Match>
          </Switch>
        </div>
      </section>

      <Show when={selected()}>
        <MailAutomationLogDetail
          detail={detail()}
          error={detailError()}
          canUndo={props.canUndo}
          busy={busy() !== null}
          time={time}
          onClose={closeDetail}
          onRetry={() => void openDetail(selected()!)}
          onUndo={(item) => void undo(item)}
          headingRef={(element) => {
            detailHeading = element;
          }}
        />
      </Show>
    </div>
  );
}

/** What Undo met instead: who changed the assignment and when, or that the conversation is gone. */
const notPossibleText = (item: AutomationLogItem, t: MailAutomationLogText, time: (iso: string) => string) => {
  if (item.undo.reason === "provider_pending") return t.providerPending;
  const by = item.undo.by;
  if (item.undo.reason === "conversation_gone" || !by) return t.notPossibleGone;
  return t.notPossible({ name: by.name, time: item.undo.at ? time(item.undo.at) : "" });
};

/** The rule that acted, or null when a person did. */
const ruleOf = (item: AutomationLogItem) => (item.by.kind === "rule" ? item.by : null);

function MailAutomationLogDetail(props: {
  detail: AutomationLogDetail | null;
  error: boolean;
  canUndo: boolean;
  busy: boolean;
  time: (iso: string) => string;
  onClose: () => void;
  onRetry: () => void;
  onUndo: (item: AutomationLogItem) => void;
  headingRef: (element: HTMLHeadingElement) => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailAutomationLogMessages.resolve([locale()]).t);
  const step = (icon: string, ai: boolean, title: string, sub: string | null): JSX.Element => (
    <li class="grid grid-cols-[2rem_1fr] gap-2.5">
      <span
        class="flex h-8 w-8 items-center justify-center rounded-full"
        classList={{ "bg-[var(--k2b-ai-surface)]": ai, "bg-[var(--ui-surface-muted)]": !ai }}
        aria-hidden="true"
      >
        <i class={`ti ${icon}`} classList={{ "text-[color:var(--k2b-ai-accent)]": ai, "text-secondary": !ai }} />
      </span>
      <span class="min-w-0">
        <b class="block text-sm font-semibold text-primary">
          {title}
          <Show when={ai}>
            <span class="sr-only"> ({t().aiMark})</span>
          </Show>
        </b>
        <Show when={sub}>
          <span class="block text-[0.8125rem] text-dimmed">{sub}</span>
        </Show>
      </span>
    </li>
  );
  const renderStep = (entry: AuditStep): JSX.Element => {
    switch (entry.kind) {
      case "rule_start":
        return step(
          "ti-bolt",
          false,
          t().ruleStarts({ name: entry.name }),
          [t().ruleMeta({ version: entry.version, position: entry.position }), ...entry.preconditions].join(" "),
        );
      case "ai_choice":
        return step("ti-sparkles", true, t().aiChooses({ value: entry.value }), t().aiChoices({ choices: entry.choices.join(", ") }));
      case "ai_value":
        return step(
          "ti-sparkles",
          true,
          t().aiReads({ field: entry.field, value: String(entry.value) }),
          entry.evidence ? t().fromSentence({ text: entry.evidence }) : null,
        );
      case "fixed_row":
        return step("ti-bolt", false, t().fixedRow({ text: entry.text }), t().fixedRowNote);
      case "result":
        return step(
          "ti-user-check",
          false,
          formatLogTitle(
            { outcome: entry.effects.length === 1 && entry.effects[0]?.kind === "assign" ? "assigned" : "effects", effects: entry.effects },
            t(),
          ),
          entry.unchanged.join(" "),
        );
    }
  };
  return (
    <aside class="flex w-[23.75rem] shrink-0 flex-col gap-4 max-md:w-full" aria-label={t().detail} data-mail-automation-log-detail>
      <Switch>
        <Match when={props.error}>
          <div class="flex flex-col items-start gap-2" role="alert">
            <p class="text-sm text-primary">{t().detailError}</p>
            <div class="flex gap-2">
              <Button size="sm" variant="secondary" onClick={props.onRetry}>
                {t().retry}
              </Button>
              <Button size="sm" variant="ghost" onClick={props.onClose}>
                {t().close}
              </Button>
            </div>
          </div>
        </Match>
        <Match when={!props.detail}>
          <div class="flex flex-col gap-3" aria-hidden="true">
            <Skeleton class="h-4 w-3/4 rounded" />
            <Skeleton class="h-3 w-full rounded" />
            <For each={[0, 1, 2, 3]}>{() => <Skeleton class="h-10 w-full rounded" />}</For>
          </div>
        </Match>
        <Match when={props.detail}>
          {(detail) => (
            <>
              <div class="flex items-start gap-2">
                <div class="min-w-0 flex-1">
                  <h2 ref={props.headingRef} tabIndex={-1} class="text-base font-semibold text-primary outline-none">
                    {formatLogTitle(detail(), t())}
                  </h2>
                  <p class="text-[0.8125rem] text-dimmed">
                    {t().on({
                      time: props.time(detail().at),
                      subject: detail().conversation.subject,
                      from: detail().conversation.from.name || detail().conversation.from.email,
                    })}
                  </p>
                </div>
                <IconButton size="sm" variant="ghost" label={t().close} onClick={props.onClose}>
                  <i class="ti ti-x" aria-hidden="true" />
                </IconButton>
              </div>
              <ol class="flex flex-col gap-3.5">
                <For each={detail().chain}>{(entry) => renderStep(entry)}</For>
              </ol>
              <Show when={ruleOf(detail())?.ai}>
                <p class="flex gap-2 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-muted)] px-3 py-2.5 text-[0.8125rem] text-primary">
                  <i class="ti ti-info-circle mt-0.5 text-secondary" aria-hidden="true" /> {t().noPerson}
                </p>
              </Show>
              <p class="flex items-center gap-1.5 text-xs text-dimmed">
                <i class="ti ti-sparkles text-[color:var(--k2b-ai-accent)]" aria-hidden="true" />
                {t().aiCalls(detail().aiCalls)}
              </p>
              <Show when={detail().undo.state === "not_possible"}>
                <p
                  class="rounded-[var(--ui-radius-control)] bg-red-50 px-3 py-2.5 text-[0.8125rem] text-red-900 dark:bg-red-950/30 dark:text-red-100"
                  role="alert"
                >
                  <b>{t().notPossibleTitle}</b> {notPossibleText(detail(), t(), props.time)}
                </p>
              </Show>
              <div class="flex flex-wrap gap-2">
                <Show when={props.canUndo && detail().undo.state === "available"}>
                  <Button size="sm" variant="secondary" disabled={props.busy} onClick={() => props.onUndo(detail())}>
                    <i class="ti ti-arrow-back-up" aria-hidden="true" /> {t().undo}
                  </Button>
                </Show>
                <ButtonLink size="sm" variant="ghost" href={detail().conversation.href}>
                  {t().openMail}
                </ButtonLink>
                <Show when={ruleOf(detail())}>
                  {(rule) => (
                    <ButtonLink size="sm" variant="ghost" href={rule().href}>
                      {t().openRule}
                    </ButtonLink>
                  )}
                </Show>
              </div>
              <p class="text-xs text-dimmed">{t().undoNote}</p>
            </>
          )}
        </Match>
      </Switch>
    </aside>
  );
}
