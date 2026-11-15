import { invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities";
import { type CodeEventCatchupInput, CodeEventCatchupInputSchema, CodeEventCatchupStatusSchema } from "@k2b/cloud/code/events";
import type { CodePageData } from "@k2b/cloud/ssr/code-page";
import { Button, ButtonLink, DatePicker, NoticeCard, ProgressBar, Section, Select, StatusBadge, useLocale } from "@k2b/ui";
import { createEffect, createSignal, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { z } from "zod";
import { MailCodeSelectionSchema } from "../mail-code-contracts";
import type { MailboxCodePageData } from "../service/workspace";
import { mailCodeMessages } from "./mail-code-messages";

export type MailCodeSelection = z.infer<typeof MailCodeSelectionSchema>;
export type MailCodeCatchUpStatus = z.infer<typeof CodeEventCatchupStatusSchema>;
/** One page of a selection after the first: the snapshot cutoff and the last message of the page before. */
export type MailCodeCatchUpPage = { cutoffAt: string; cursor: { date: string; id: string } };
export type MailCodeCatchUpPick = { folder: string | null; from: string | null; to: string | null };
/** Why the flow cannot run here; the server decides it from the Code and the mailbox access. */
export type MailCodeCatchUpBlocked = "none" | "paused" | "reader" | "scope";

/** Serializable initial data from the catch-up page, rendered unchanged by the server and the browser. */
export type MailCodeCatchUpData = {
  mailboxId: string;
  /** The mailbox's Code page this flow belongs to. */
  codeHref: string;
  blocked: MailCodeCatchUpBlocked | null;
  codeId: string | null;
  /** The switched-on version, which every new preview and start uses. */
  version: { id: string; number: number } | null;
  /** Incoming folders only: the selection never reads sent, drafts, junk, or trash. */
  folders: { id: string; name: string }[];
  pick: MailCodeCatchUpPick;
  page: MailCodeCatchUpPage | null;
  /** The version the shown preview was made with; null without a preview. */
  previewVersionId: string | null;
  selection: MailCodeSelection | null;
  selectionFailed: boolean;
  operationId: string | null;
  operation: MailCodeCatchUpStatus | null;
  /** The operation's status could not be read. */
  operationFailed: boolean;
  /** Number of the version the operation is pinned to, when the page knows it. */
  operationVersion: number | null;
  /** The selection page after the operation's messages, when there were more. */
  next: MailCodeCatchUpPage | null;
  /** A newer version is switched on than the preview or the stopped operation used. */
  stale: { version: number; done: number; old: number | null } | null;
};

const dateKey = /^\d{4}-\d{2}-\d{2}$/;
const uuid = z.uuid();
const PageSchema = z.object({
  cutoffAt: z.iso.datetime({ offset: true }),
  cursor: z.object({ date: z.iso.datetime({ offset: true }), id: z.uuid() }),
});
/** A page travels in the address as `cutoff_date_id`; ISO times and UUIDs contain no underscore. */
export const encodeCatchUpPage = (page: MailCodeCatchUpPage) => `${page.cutoffAt}_${page.cursor.date}_${page.cursor.id}`;
export const decodeCatchUpPage = (value: string | null): MailCodeCatchUpPage | null => {
  const [cutoffAt, date, id] = (value ?? "").split("_");
  const parsed = PageSchema.safeParse({ cutoffAt, cursor: { date, id } });
  return parsed.success ? parsed.data : null;
};

/** What the address says: the selection, the shown preview, and the operation. Unknown values fall back to none. */
export const readCatchUpAddress = (url: URL) => {
  const param = (name: string) => url.searchParams.get(name);
  const day = (name: string) => (dateKey.test(param(name) ?? "") ? param(name) : null);
  const id = (name: string) => (uuid.safeParse(param(name)).success ? param(name) : null);
  return {
    pick: { folder: /^[A-Za-z0-9]{1,32}$/.test(param("folder") ?? "") ? param("folder") : null, from: day("from"), to: day("to") },
    page: decodeCatchUpPage(param("page")),
    previewVersionId: id("preview"),
    operationId: id("operation"),
    next: decodeCatchUpPage(param("next")),
  };
};

const catchUpAddress = (
  base: string,
  state: {
    pick: MailCodeCatchUpPick;
    page: MailCodeCatchUpPage | null;
    previewVersionId: string | null;
    operationId: string | null;
    next: MailCodeCatchUpPage | null;
  },
) => {
  const query = new URLSearchParams();
  if (state.pick.folder) query.set("folder", state.pick.folder);
  if (state.pick.from) query.set("from", state.pick.from);
  if (state.pick.to) query.set("to", state.pick.to);
  if (state.operationId) {
    query.set("operation", state.operationId);
    if (state.next) query.set("next", encodeCatchUpPage(state.next));
  } else if (state.previewVersionId) {
    query.set("preview", state.previewVersionId);
    if (state.page) query.set("page", encodeCatchUpPage(state.page));
  }
  const suffix = query.size ? `?${query}` : "";
  return `${base}${suffix}`;
};

/**
 * Whether this person can process existing mail with the mailbox's Code: an editor of a switched-on Code with read
 * access to the whole mailbox. A paused Code offers nothing.
 */
export const mailCodeCatchUpAvailable = (code: CodePageData, mailbox: { access: Pick<MailboxCodePageData["access"], "scope"> }) =>
  code.state.kind === "ready" &&
  code.state.permission === "editor" &&
  code.state.code.state === "active" &&
  !!code.state.code.activeVersionId &&
  mailbox.access.scope === "mailbox";

/** The catch-up flow's own address beside the mailbox's Code page. */
export const mailCodeCatchUpHref = (codeHref: string) => `${codeHref}/catch-up`;

/** The input of Mail's selection query. "To" is inclusive: the selection ends before the next day. */
export const mailCodeSelectionInput = (pick: MailCodeCatchUpPick, page: MailCodeCatchUpPage | null) => {
  const nextDay = (key: string) => new Date(Date.parse(`${key}T00:00:00.000Z`) + 86_400_000).toISOString();
  return {
    ...(pick.folder ? { folderId: pick.folder } : {}),
    ...(pick.from ? { from: `${pick.from}T00:00:00.000Z` } : {}),
    ...(pick.to ? { to: nextDay(pick.to) } : {}),
    ...(page ? { cutoffAt: page.cutoffAt, cursor: page.cursor } : {}),
  };
};

/** The page after this selection, when Mail found more messages than one operation takes. */
const nextPage = (selection: MailCodeSelection): MailCodeCatchUpPage | null =>
  selection.nextCursor ? { cutoffAt: selection.cutoffAt, cursor: selection.nextCursor } : null;

/** Folder roles the selection reads, the same rule as Mail's selection query. */
const NOT_INCOMING = new Set(["trash", "junk", "sent", "drafts", "all"]);
export const mailCodeIncomingFolders = (folders: readonly { id: string; name: string; role: string | null }[]) =>
  folders.filter((folder) => !NOT_INCOMING.has(folder.role ?? "")).map((folder) => ({ id: folder.id, name: folder.name }));

/**
 * Why Core stopped an operation, in words. Core's status carries only its English message; these three causes have a
 * consequence the person can act on. Anything else stays generic.
 */
const failureCause = (lastError: string | null): "access" | "busy" | "other" => {
  const text = lastError?.toLowerCase() ?? "";
  if (/resource access|execution binding|execution mandate|permission/.test(text)) return "access";
  if (/capacity|waiting budget|backlog/.test(text)) return "busy";
  return "other";
};

type Issue =
  | { kind: "refused"; action: "start" | "resume" | "stop"; status: number }
  | { kind: "busy" }
  | { kind: "unclear-stop" }
  | { kind: "preview-failed" }
  | { kind: "read-failed" };

const refusal = new Set([400, 403, 404, 409, 413, 422]);
const ACTIVE = new Set(["queued", "running", "waiting"]);
const SavedSchema = z.object({
  operationId: z.uuid().nullable(),
  pending: CodeEventCatchupInputSchema.nullable(),
  resume: z.object({ operationId: z.uuid(), newOperationId: z.uuid() }).nullable().default(null),
  next: PageSchema.nullable().default(null),
});
const CodeReadSchema = z.object({ code: z.object({ state: z.string(), activeVersionId: z.string().nullable() }) });

/** The quiet line at the end of the Code overview that leads to processing existing mail. */
export function MailCodeBackfillLink(props: { href: string }): JSX.Element {
  const locale = useLocale();
  const t = () => mailCodeMessages.resolve([locale()]).t;
  return (
    <p class="mail-code-backfill">
      <i class="ti ti-history" aria-hidden="true" />
      <span>
        {t().linkLead}{" "}
        <a class="k2b-text-link" href={props.href}>
          {t().link}
        </a>
      </span>
    </p>
  );
}

/** One row of a result list: a leading sign on one axis, then the sentence. */
const Row = (props: { icon: string; tone?: "ok" | "warning"; children: JSX.Element }) => (
  <li class="mail-code-catchup__row" data-tone={props.tone}>
    <i class={`ti ${props.icon}`} aria-hidden="true" />
    <span>{props.children}</span>
  </li>
);

/**
 * "Process existing mail": Mail selects existing messages, Core applies the switched-on version to them. Writing
 * actions keep their three outcomes: done, refused (nothing changed), or unclear with "Check status".
 */
export default function MailCodeCatchUp(props: { data: MailCodeCatchUpData }): JSX.Element {
  const locale = useLocale();
  const t = () => mailCodeMessages.resolve([locale()]).t;
  const data = props.data;
  const [folder, setFolder] = createSignal(data.pick.folder);
  const [from, setFrom] = createSignal(data.pick.from);
  const [to, setTo] = createSignal(data.pick.to);
  const [page, setPage] = createSignal(data.page);
  const [selection, setSelection] = createSignal(data.selection);
  const [previewVersionId, setPreviewVersionId] = createSignal(data.selection ? data.previewVersionId : null);
  const [operationId, setOperationId] = createSignal(data.operationId);
  const [progress, setProgress] = createSignal(data.operation);
  const [operationVersion, setOperationVersion] = createSignal(data.operationVersion);
  const [next, setNext] = createSignal(data.next);
  const [stale, setStale] = createSignal(data.stale);
  const [pending, setPending] = createSignal<CodeEventCatchupInput | null>(null);
  const [pendingResume, setPendingResume] = createSignal<{ operationId: string; newOperationId: string } | null>(null);
  const [issue, setIssue] = createSignal<Issue | null>(
    data.selectionFailed ? { kind: "preview-failed" } : data.operationFailed ? { kind: "read-failed" } : null,
  );
  const [busy, setBusy] = createSignal(false);
  let pickRow: HTMLDivElement | undefined;

  const version = () => data.version?.number ?? 0;
  const pick = (): MailCodeCatchUpPick => ({ folder: folder(), from: from(), to: to() });
  const target = () => ({ type: "core.code", id: data.codeId ?? "" });
  const href = () => mailCodeCatchUpHref(data.codeHref);
  const runsHref = () => `${data.codeHref}?tab=runs`;
  const storageKey = () => `mail.code.catchup:${data.codeId}`;
  const remember = () => {
    try {
      sessionStorage.setItem(
        storageKey(),
        JSON.stringify({ operationId: operationId(), pending: pending(), resume: pendingResume(), next: next() }),
      );
    } catch {
      /* The current page still holds its receipt. */
    }
  };
  // The address follows the state, so reload and the back button return to the same step.
  createEffect(() => {
    const address = catchUpAddress(href(), {
      pick: pick(),
      page: page(),
      previewVersionId: selection() ? previewVersionId() : null,
      operationId: progress() || pending() || pendingResume() || issue()?.kind === "read-failed" ? operationId() : null,
      next: next(),
    });
    if (`${location.pathname}${location.search}` !== address) history.replaceState(history.state, "", address);
  });

  const run = async (action: () => Promise<void>) => {
    if (busy()) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  const invokeCore = (capabilityId: string, kind: "query" | "action", input: object, key?: string) =>
    invokeCapabilityWithDataSchema(
      { appId: "core", capabilityId, kind, target: target(), input, ...(key ? { idempotencyKey: key } : {}) },
      CodeEventCatchupStatusSchema,
    );
  const accept = (status: MailCodeCatchUpStatus) => {
    setProgress(status);
    setOperationId(status.operationId);
    setPending(null);
    setPendingResume(null);
    setIssue(null);
    remember();
  };
  /** Whether a newer version is switched on; then the server renders the stale preview with its numbers. */
  const versionMoved = async () => {
    const read = await invokeCapabilityWithDataSchema(
      { appId: "core", capabilityId: "code.read", kind: "query", target: target(), input: { codeId: data.codeId } },
      CodeReadSchema,
    );
    return read.ok && (read.data.data.code.state !== "active" || read.data.data.code.activeVersionId !== data.version?.id);
  };
  const reloadAt = (state: Parameters<typeof catchUpAddress>[1]) => location.assign(catchUpAddress(href(), state));

  const refresh = async () => {
    const id = operationId();
    if (!id) return;
    const result = await invokeCore("code.event.catchup.read", "query", { operationId: id });
    if (!result.ok) {
      setIssue({ kind: "read-failed" });
      return;
    }
    const before = progress()?.status;
    accept(result.data.data);
    if (result.data.data.status === "failed" && before !== "failed" && (await versionMoved()))
      reloadAt({ pick: pick(), page: null, previewVersionId: null, operationId: id, next: next() });
  };

  const loadPreview = async (at: MailCodeCatchUpPage | null) => {
    const result = await invokeCapabilityWithDataSchema(
      {
        appId: "mail",
        capabilityId: "message.catchup",
        kind: "query",
        target: { type: "mail.mailbox", id: data.mailboxId },
        input: mailCodeSelectionInput(pick(), at),
      },
      MailCodeSelectionSchema,
    );
    if (!result.ok) {
      setIssue({ kind: "preview-failed" });
      return;
    }
    setSelection(result.data.data);
    setPage(at);
    setPreviewVersionId(data.version?.id ?? null);
    setStale(null);
    setProgress(null);
    setOperationId(null);
    setNext(null);
    setIssue(null);
    remember();
  };
  const otherSelection = () => {
    setSelection(null);
    setPage(null);
    setIssue(null);
    pickRow?.querySelector<HTMLElement>("button, input")?.focus();
  };
  const changePick = (apply: () => void) => {
    apply();
    // A preview belongs to exactly one selection.
    setSelection(null);
    setPage(null);
  };

  const start = async () => {
    const shown = selection();
    const versionId = data.version?.id;
    const saved = pending();
    if (!saved && (!shown || !versionId)) return;
    const request = saved ?? {
      operationId: crypto.randomUUID(),
      versionId: versionId ?? "",
      events: (shown?.items ?? []).map((item) => item.event),
    };
    if (shown) setNext(nextPage(shown));
    setPending(request);
    setOperationId(request.operationId);
    remember();
    const result = await invokeCore("code.event.catchup", "action", request, request.operationId);
    if (result.ok) {
      setOperationVersion(version());
      setSelection(null);
      accept(result.data.data);
      return;
    }
    if (result.error.status === 409) {
      if (await versionMoved()) {
        setPending(null);
        remember();
        reloadAt({ pick: pick(), page: page(), previewVersionId: request.versionId, operationId: null, next: null });
        return;
      }
      // Another start of this snapshot may be under way: keep the exact receipt and check it.
      setIssue({ kind: "busy" });
      return;
    }
    if (refusal.has(result.error.status)) {
      setPending(null);
      setOperationId(null);
      setNext(null);
      remember();
      setIssue({ kind: "refused", action: "start", status: result.error.status });
    }
    // Any other answer leaves the outcome unclear; the kept receipt resends the same snapshot.
  };
  const resume = async () => {
    const previous = { id: operationId(), status: progress() };
    const saved = pendingResume();
    if (!saved && !previous.id) return;
    const request = saved ?? { operationId: previous.id ?? "", newOperationId: crypto.randomUUID() };
    setPendingResume(request);
    setOperationId(request.newOperationId);
    setProgress(null);
    remember();
    const result = await invokeCore("code.event.catchup.resume", "action", request, request.newOperationId);
    if (result.ok) {
      accept(result.data.data);
      return;
    }
    if (result.error.status === 409 && !(await versionMoved())) {
      // The same resume may be under way, or Core holds its key as uncertain: keep the receipt and check it.
      setIssue({ kind: "busy" });
      return;
    }
    if (refusal.has(result.error.status)) {
      setPendingResume(null);
      setOperationId(request.operationId);
      setProgress(previous.status);
      remember();
      if (result.error.status === 409) {
        reloadAt({ pick: pick(), page: null, previewVersionId: null, operationId: request.operationId, next: next() });
        return;
      }
      setIssue({ kind: "refused", action: "resume", status: result.error.status });
      if (!previous.status) await refresh();
    }
  };
  /**
   * "Check status" after an unclear start or resume: read the operation first. Only when Core does not know it at all
   * has nothing started, and only then is the same receipt sent again under the same key; any other answer stays unclear.
   */
  const checkUnclear = async () => {
    const id = pending()?.operationId ?? pendingResume()?.newOperationId ?? null;
    if (!id) return;
    const read = await invokeCore("code.event.catchup.read", "query", { operationId: id });
    if (read.ok) {
      setOperationVersion(version());
      setSelection(null);
      accept(read.data.data);
      return;
    }
    if (read.error.status === 404) await (pending() ? start() : resume());
  };
  const stop = async () => {
    const id = operationId();
    if (!id) return;
    const result = await invokeCore("code.event.catchup.cancel", "action", { operationId: id }, `cancel:${id}`);
    if (result.ok) accept(result.data.data);
    else
      setIssue(
        refusal.has(result.error.status) ? { kind: "refused", action: "stop", status: result.error.status } : { kind: "unclear-stop" },
      );
  };
  const end = () => {
    setProgress(null);
    setOperationId(null);
    setNext(null);
    setPending(null);
    setPendingResume(null);
    setIssue(null);
    remember();
  };

  onMount(() => {
    if (data.blocked || !data.codeId) return;
    try {
      const saved = SavedSchema.parse(JSON.parse(sessionStorage.getItem(storageKey()) ?? "null"));
      // An unconfirmed start or continuation is shown as unclear until its status is checked.
      if (saved.pending && (!data.operationId || data.operationId === saved.pending.operationId)) {
        setPending(saved.pending);
        setOperationId(saved.pending.operationId);
        setNext(saved.next);
      } else if (saved.resume && (!data.operationId || data.operationId === saved.resume.newOperationId)) {
        setPendingResume(saved.resume);
        setOperationId(saved.resume.newOperationId);
        setProgress(null);
        setNext(saved.next);
      } else if (!data.operationId && !data.selection && !data.stale && saved.operationId) {
        // Back from elsewhere: show the operation this tab started while it still matters.
        setOperationId(saved.operationId);
        setNext(saved.next);
        void run(async () => {
          await refresh();
          if (progress()?.status === "completed") end();
        });
      }
    } catch {
      /* No saved operation. */
    }
  });
  onMount(() => {
    const timer = setInterval(() => {
      if (ACTIVE.has(progress()?.status ?? "") && !busy()) void run(refresh);
    }, 3_000);
    onCleanup(() => clearInterval(timer));
  });

  type View = "blocked" | "stale" | "unclear" | "lost" | "running" | "paused" | "failed" | "done" | "preview" | "pick";
  const view = (): View => {
    if (data.blocked || !data.version) return "blocked";
    if (stale()) return "stale";
    const status = progress()?.status;
    if (status === "completed") return "done";
    if (status === "failed") return "failed";
    if (status === "canceled") return "paused";
    if (status) return "running";
    if (pending() || pendingResume()) return "unclear";
    if (operationId() && issue()?.kind === "read-failed") return "lost";
    if (selection()) return "preview";
    return "pick";
  };

  const dayLabel = (key: string) =>
    new Intl.DateTimeFormat(
      locale(),
      locale().startsWith("de")
        ? { day: "2-digit", month: "2-digit", timeZone: "UTC" }
        : { day: "numeric", month: "short", timeZone: "UTC" },
    ).format(new Date(`${key}T00:00:00.000Z`));
  const scope = (count: number) => {
    const first = from();
    const last = to();
    const range =
      first && last
        ? t().rangeBoth({ from: dayLabel(first), to: dayLabel(last) })
        : first
          ? t().rangeFrom({ from: dayLabel(first) })
          : last
            ? t().rangeTo({ to: dayLabel(last) })
            : "";
    const name = data.folders.find((item) => item.id === folder())?.name ?? null;
    return t().scope({ count, range, folder: name });
  };
  const done = () => progress()?.dispatched ?? 0;
  const total = () => progress()?.total ?? 0;
  const failed = () => Math.max(0, total() - done());
  const percent = () =>
    new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 0 }).format(total() ? done() / total() : 0);
  const reason = (status: number) =>
    status === 403
      ? t().reasonForbidden
      : status === 404
        ? t().reasonGone
        : status === 413
          ? t().reasonTooLarge
          : status === 400 || status === 422
            ? t().reasonUnsupported
            : t().reasonOther;

  const Pick = () => (
    <Section
      frame="line"
      size="md"
      title={t().pickTitle}
      footer={
        <p class="mail-code-catchup__quiet">
          <i class="ti ti-eye" aria-hidden="true" />
          <span>{t().pickHint}</span>
        </p>
      }
    >
      <div class="mail-code-catchup__pick" ref={pickRow}>
        <Select
          label={t().folder}
          value={folder}
          onValueChange={(value) => changePick(() => setFolder(value))}
          options={data.folders.map((item) => ({ id: item.id, label: item.name }))}
          placeholder={t().allFolders}
          clearable
          disabled={busy()}
        />
        <DatePicker
          label={t().from}
          value={from}
          max={to() ?? undefined}
          onValueChange={(value) => changePick(() => setFrom(value))}
          clearable
          disabled={busy()}
        />
        <DatePicker
          label={t().to}
          value={to}
          min={from() ?? undefined}
          onValueChange={(value) => changePick(() => setTo(value))}
          clearable
          disabled={busy()}
        />
        <div class="mail-code-catchup__load">
          <Button variant="secondary" loading={busy() && !selection()} disabled={busy()} onClick={() => void run(() => loadPreview(null))}>
            {t().loadPreview}
          </Button>
        </div>
      </div>
    </Section>
  );
  const Preview = (preview: { selection: MailCodeSelection }) => {
    const count = () => preview.selection.items.length;
    return (
      <Section
        frame="line"
        size="md"
        title={t().previewTitle}
        meta={t().withVersion({ version: version() })}
        footer={
          <>
            <Show when={count() > 0}>
              <Button disabled={busy()} loading={busy()} onClick={() => void run(start)}>
                {t().apply({ count: count() })}
              </Button>
            </Show>
            <Button variant="secondary" disabled={busy()} onClick={otherSelection}>
              {t().otherSelection}
            </Button>
          </>
        }
      >
        <Show when={count() > 0} fallback={<p class="mail-code-catchup__entry">{t().previewEmpty}</p>}>
          <p class="mail-code-catchup__scope">{scope(count())}</p>
          <ul class="mail-code-catchup__rows">
            <Row icon="ti-circle-check" tone="ok">
              {t().previewGets({ count: count() })}
            </Row>
            <Row icon="ti-minus">{t().previewSkips({ version: version() })}</Row>
            <Show when={preview.selection.nextCursor}>
              <Row icon="ti-info-circle">{t().previewMore}</Row>
            </Show>
          </ul>
        </Show>
      </Section>
    );
  };
  const refused = () => {
    const current = issue();
    return current?.kind === "refused" ? current : null;
  };
  const IssueNotice = () => (
    <>
      <Show when={refused()}>
        {(current) => (
          <div role="alert">
            <NoticeCard
              tone="danger"
              icon
              layout="card"
              title={current().action === "start" ? t().refusedStart : current().action === "resume" ? t().refusedResume : t().refusedStop}
              detail={current().action === "stop" ? reason(current().status) : `${reason(current().status)} ${t().unchanged}`}
            />
          </div>
        )}
      </Show>
      <Show when={issue()?.kind === "unclear-stop"}>
        <div role="status">
          <NoticeCard
            tone="warning"
            icon="ti ti-help-circle"
            layout="card"
            title={t().unclearStop}
            detail={t().unclearStopDetail}
            actions={
              <Button size="sm" disabled={busy()} onClick={() => void run(refresh)}>
                {t().checkStatus}
              </Button>
            }
          />
        </div>
      </Show>
      <Show when={issue()?.kind === "preview-failed"}>
        <div role="alert">
          <NoticeCard
            tone="danger"
            icon
            layout="card"
            title={t().previewFailed}
            detail={t().nothingChanges}
            actions={
              <Button size="sm" disabled={busy()} onClick={() => void run(() => loadPreview(page()))}>
                {t().retry}
              </Button>
            }
          />
        </div>
      </Show>
      <Show when={issue()?.kind === "read-failed"}>
        <div role="alert">
          <NoticeCard
            tone="danger"
            icon
            layout="card"
            title={t().readFailed}
            detail={t().readFailedDetail}
            actions={
              <Button size="sm" disabled={busy()} onClick={() => void run(refresh)}>
                {t().retry}
              </Button>
            }
          />
        </div>
      </Show>
    </>
  );

  return (
    <div class="mail-code-catchup">
      <header class="mail-code-catchup__head">
        <a class="k2b-text-link mail-code-catchup__back" href={data.codeHref}>
          <i class="ti ti-chevron-left" aria-hidden="true" />
          {t().back}
        </a>
        <h1 class="mail-code-catchup__title">{t().title}</h1>
        <Show when={data.version}>{(active) => <p class="mail-code-catchup__lead">{t().lead({ version: active().number })}</p>}</Show>
      </header>
      <div class="mail-code-catchup__stack" aria-live="polite">
        <Switch>
          <Match when={view() === "blocked"}>
            <NoticeCard
              tone="neutral"
              icon="ti ti-info-circle"
              layout="card"
              title={
                data.blocked === "paused"
                  ? t().blockedPaused
                  : data.blocked === "reader"
                    ? t().blockedReader
                    : data.blocked === "scope"
                      ? t().blockedScope
                      : t().blockedNone
              }
              actions={
                <ButtonLink size="sm" variant="secondary" href={data.codeHref}>
                  {t().backToCode}
                </ButtonLink>
              }
            />
          </Match>
          <Match when={view() === "stale" && stale()}>
            {(current) => (
              <>
                <IssueNotice />
                <div role="status">
                  <NoticeCard
                    tone="warning"
                    icon
                    layout="card"
                    title={t().staleTitle({ version: current().version })}
                    detail={
                      current().done > 0 && current().old !== null
                        ? t().staleSome({ done: current().done, old: current().old ?? 0, version: current().version })
                        : t().staleNothing({ version: current().version })
                    }
                    actions={
                      <Button size="sm" disabled={busy()} loading={busy()} onClick={() => void run(() => loadPreview(page()))}>
                        <i class="ti ti-refresh" aria-hidden="true" />
                        {t().reloadPreview}
                      </Button>
                    }
                  />
                </div>
                <Pick />
              </>
            )}
          </Match>
          <Match when={view() === "unclear"}>
            <div role="status">
              <NoticeCard
                tone="warning"
                icon="ti ti-help-circle"
                layout="card"
                title={issue()?.kind === "busy" ? t().busyTitle : t().unclearStart}
                detail={issue()?.kind === "busy" ? t().busyDetail : t().unclearStartDetail}
                actions={
                  <Button size="sm" disabled={busy()} loading={busy()} onClick={() => void run(checkUnclear)}>
                    {t().checkStatus}
                  </Button>
                }
              />
            </div>
          </Match>
          <Match when={view() === "lost"}>
            <IssueNotice />
          </Match>
          <Match when={view() === "running"}>
            <IssueNotice />
            <Section
              frame="line"
              size="md"
              title={t().runningTitle}
              meta={operationVersion() ? t().withVersion({ version: operationVersion() ?? 0 }) : undefined}
              actions={<StatusBadge tone="running" icon="ti ti-loader-2" label={t().running} labels={[t().running, t().paused]} />}
              footer={
                <Button variant="secondary" size="sm" disabled={busy()} onClick={() => void run(stop)}>
                  <i class="ti ti-player-pause" aria-hidden="true" />
                  {t().stop}
                </Button>
              }
            >
              <p class="mail-code-catchup__scope">{scope(total())}</p>
              <div class="mail-code-catchup__progress">
                <span class="mail-code-catchup__percent">{percent()}</span>
                <ProgressBar value={total() ? (done() / total()) * 100 : 0} label={t().runningTitle} valueText={percent()} />
              </div>
              <p class="mail-code-catchup__meta">{t().handedOver({ done: done(), total: total() })}</p>
            </Section>
          </Match>
          <Match when={view() === "paused"}>
            <IssueNotice />
            <Section
              frame="line"
              size="md"
              title={t().pausedTitle}
              meta={operationVersion() ? t().withVersion({ version: operationVersion() ?? 0 }) : undefined}
              actions={<StatusBadge tone="warning" icon="ti ti-player-pause" label={t().paused} labels={[t().running, t().paused]} />}
              footer={
                <>
                  <Button disabled={busy()} loading={busy()} onClick={() => void run(resume)}>
                    <i class="ti ti-player-play" aria-hidden="true" />
                    {t().resume}
                  </Button>
                  <Button variant="secondary" disabled={busy()} onClick={end}>
                    {t().end}
                  </Button>
                </>
              }
            >
              <p class="mail-code-catchup__scope">{scope(total())}</p>
              <p class="mail-code-catchup__meta">{t().pausedDetail({ done: done(), total: total() })}</p>
            </Section>
          </Match>
          <Match when={view() === "failed"}>
            <IssueNotice />
            <div role="alert">
              <NoticeCard
                tone="danger"
                icon
                layout="card"
                title={`${t().failedTitle({ failed: failed(), total: total() })} ${
                  failureCause(progress()?.lastError ?? null) === "access"
                    ? t().failedAccess
                    : failureCause(progress()?.lastError ?? null) === "busy"
                      ? t().failedBusy
                      : t().failedOther
                }`}
                detail={t().failedDetail({ done: done(), failed: failed() })}
                actions={
                  <>
                    <Show when={failureCause(progress()?.lastError ?? null) === "access"}>
                      <ButtonLink size="sm" variant="secondary" href={data.codeHref}>
                        {t().checkAccess}
                      </ButtonLink>
                    </Show>
                    <Button size="sm" variant="secondary" disabled={busy()} loading={busy()} onClick={() => void run(resume)}>
                      <i class="ti ti-refresh" aria-hidden="true" />
                      {t().retryFailed({ count: failed() })}
                    </Button>
                  </>
                }
              />
            </div>
            <Section
              frame="line"
              size="md"
              title={t().resultTitle}
              meta={operationVersion() ? t().withVersion({ version: operationVersion() ?? 0 }) : undefined}
              footer={
                <ButtonLink size="sm" variant="secondary" href={runsHref()}>
                  {t().viewRuns}
                </ButtonLink>
              }
            >
              <ul class="mail-code-catchup__rows">
                <Row icon="ti-circle-check" tone="ok">
                  {t().resultHanded({ count: done() })}
                </Row>
                <Row icon="ti-alert-triangle" tone="warning">
                  {t().resultFailed({ count: failed() })}
                </Row>
                <Row icon="ti-info-circle">{t().resultRuns}</Row>
              </ul>
            </Section>
          </Match>
          <Match when={view() === "done"}>
            <IssueNotice />
            <div role="status">
              <NoticeCard
                tone="success"
                icon
                layout="card"
                title={t().doneTitle({ count: total() })}
                detail={t().doneDetail}
                actions={
                  <>
                    <ButtonLink size="sm" variant="secondary" href={runsHref()}>
                      {t().viewRuns}
                    </ButtonLink>
                    <Show when={next()}>
                      {(more) => (
                        <Button size="sm" variant="secondary" disabled={busy()} onClick={() => void run(() => loadPreview(more()))}>
                          {t().nextMessages}
                        </Button>
                      )}
                    </Show>
                  </>
                }
              />
            </div>
            <Pick />
          </Match>
          <Match when={view() === "preview" && selection()}>
            {(shown) => (
              <>
                <IssueNotice />
                <Pick />
                <Preview selection={shown()} />
              </>
            )}
          </Match>
          <Match when={view() === "pick"}>
            <IssueNotice />
            <Pick />
          </Match>
        </Switch>
      </div>
    </div>
  );
}
