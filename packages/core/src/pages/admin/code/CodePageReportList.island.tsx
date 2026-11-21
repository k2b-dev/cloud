import { formatDateTime } from "@k2b/cloud/shared";
import type { DateContext } from "@k2b/stdlib";
import { Button, LoadMore, NoticeCard, useLocale } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { z } from "zod";
import { type CodePageReport, CodePageReportPageSchema } from "../../../code/page-report-contracts";
import { postCodeAdmin, reloadCodeArea } from "./client";
import { codePageReportMessages } from "./report-messages";

/** One report: why, what the person wrote, which page, who and when, and "Mark done". */
function ReportRow(props: { codeId: string; report: CodePageReport; dateConfig: DateContext }) {
  const locale = useLocale();
  const t = () => codePageReportMessages.resolve([locale()]).t;
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const href = () => `/code/${encodeURIComponent(props.codeId)}${props.report.path}`;
  const resolve = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await postCodeAdmin(
        "reports/resolve",
        { codeId: props.codeId, reportId: props.report.id },
        z.object({ state: z.literal("resolved"), resolvedAt: z.string() }),
      );
      // The canonical read counts and lists again, the sidebar included.
      reloadCodeArea();
    } catch {
      setBusy(false);
      setFailed(true);
    }
  };
  return (
    <li class="grid gap-1.5" data-code-page-report={props.report.id}>
      <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span class="text-sm font-semibold">{props.report.reason ? t().reason({ reason: props.report.reason }) : t().noReason}</span>
        <a class="k2b-text-link min-w-0 truncate text-xs" href={href()} aria-label={t().openPage({ path: props.report.path })}>
          {props.report.path}
        </a>
      </div>
      <p class="text-sm whitespace-pre-line break-words">{props.report.text}</p>
      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span class="text-xs text-(--k2b-text-muted)">
          {t().by({ name: props.report.reporter.name, when: formatDateTime(props.report.createdAt, props.dateConfig) })}
        </span>
        <Button variant="secondary" size="sm" loading={busy()} onClick={() => void resolve()}>
          <i class="ti ti-check" aria-hidden="true" />
          {t().resolve}
        </Button>
      </div>
      <Show when={failed()}>
        <NoticeCard tone="danger" title={t().resolveFailed} />
      </Show>
    </li>
  );
}

/**
 * The open reports of one automation for Cloud admins, newest first, as the server read them; further pages load at
 * the end of the list. "Mark done" resolves one report, tells the person who filed it, and reads the area again.
 */
export default function CodePageReportList(props: {
  codeId: string;
  items: CodePageReport[];
  nextCursor: string | null;
  dateConfig: DateContext;
}) {
  const locale = useLocale();
  const t = () => codePageReportMessages.resolve([locale()]).t;
  const [items, setItems] = createSignal(props.items);
  const [cursor, setCursor] = createSignal(props.nextCursor);
  const more = async () => {
    const after = cursor();
    if (!after) return false;
    try {
      const page = await postCodeAdmin("reports/list", { codeId: props.codeId, state: "open", cursor: after }, CodePageReportPageSchema);
      setItems((current) => [...current, ...page.items.filter((item) => !current.some((known) => known.id === item.id))]);
      setCursor(page.nextCursor);
    } catch {
      throw new Error(t().moreFailed);
    }
  };
  return (
    <div class="grid">
      <ul class="grid gap-5" aria-label={t().title}>
        <For each={items()}>{(report) => <ReportRow codeId={props.codeId} report={report} dateConfig={props.dateConfig} />}</For>
      </ul>
      <LoadMore
        hasMore={cursor() !== null}
        onLoadMore={more}
        count={items().length}
        label={t().more}
        loadingLabel={t().moreLoading}
        errorLabel={t().moreFailed}
      />
    </div>
  );
}
