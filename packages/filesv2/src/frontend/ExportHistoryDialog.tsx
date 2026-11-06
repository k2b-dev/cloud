import { downloadFileFromContent } from "@k2b/stdlib/browser";
import {
  Button,
  DateRangePicker,
  type DateRangeValue,
  type DialogRender,
  InlineGuidance,
  prompts,
  SegmentedControl,
  Select,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import { z } from "zod";
import type { ActivityBasesInput, ActivityBasesPage, HistoryAction } from "../activity-contracts";
import type { ActivityExportInput } from "../activity-export-contracts";
import { apiClient } from "../api/client";
import {
  type AdminActivityBase,
  type AdminActivityFilters,
  type AdminBasesLoader,
  adminBaseOptions,
  defaultExportPeriod,
  type ExportFormat,
  type ExportRequest,
  exportFileName,
  exportRequest,
} from "./admin-history";
import { useAdminHistoryMessages } from "./admin-history-messages";
import { useHistoryMessages } from "./history-messages";

export type ExportHistoryOptions = {
  title: string;
  /** The list's filters; the dialog exports them with its own period, storage and format. */
  filters: AdminActivityFilters;
  bases: ActivityBasesPage | null;
  baseLabels: readonly AdminActivityBase[];
  loadBases: AdminBasesLoader;
  /** Names of people seen in the list, to name a kept person filter. */
  people: Readonly<Record<string, string>>;
  whatLabel: (action: HistoryAction) => string;
  /** The page's clock, so the default period matches the list. */
  now: string;
};

/** Opens the export; it resolves when the dialog closes. Cancelling leaves the list and its filters as they are. */
export const openExportHistoryDialog = (options: ExportHistoryOptions) =>
  prompts.dialog<void>(
    (close, context) => <ExportHistoryDialog {...options} close={close} setDismissHandler={context.setDismissHandler} />,
    { title: options.title, size: "medium", history: true },
  );

/** A bounded picker shared by the history filter and export; each More action requests exactly one page. */
export const openAdminBasePicker = (options: {
  bases: ActivityBasesPage | null;
  selected?: string;
  labels: readonly AdminActivityBase[];
  load: AdminBasesLoader;
  title: string;
}) =>
  prompts.dialog<string | null>(
    (close, context) => {
      const a = useAdminHistoryMessages();
      const locale = useLocale();
      const [text, setText] = createSignal("");
      const [page, setPage] = createSignal(options.bases);
      const [loading, setLoading] = createSignal(false);
      const [failed, setFailed] = createSignal(false);
      let controller: AbortController | undefined;
      let last: ActivityBasesInput = {};
      const load = async (input: ActivityBasesInput, append = false) => {
        controller?.abort();
        const current = new AbortController();
        controller = current;
        last = input;
        setLoading(true);
        setFailed(false);
        try {
          const next = await options.load(input, current.signal);
          if (current.signal.aborted) return;
          setPage((previous) => ({ items: append ? [...(previous?.items ?? []), ...next.items] : next.items, next: next.next }));
        } catch {
          if (!current.signal.aborted) setFailed(true);
        } finally {
          if (!current.signal.aborted) setLoading(false);
        }
      };
      const search = () => {
        setPage(null);
        void load({ ...(text().trim() ? { q: text().trim() } : {}) });
      };
      createEffect(() => {
        if (!options.bases) void load({});
      });
      const cancel = () => {
        controller?.abort();
        close(null);
      };
      context.setDismissHandler(cancel);
      onCleanup(() => controller?.abort());
      const choices = () => adminBaseOptions(page()?.items ?? [], a(), locale());
      const selectedLabel = () => adminBaseOptions(options.labels, a(), locale()).find((base) => base.value === options.selected)?.label;
      return (
        <div class="flex flex-col gap-3">
          <TextInput type="search" label={a().baseSearch} value={text} onValueChange={setText} maxLength={4096} onSubmit={search} />
          <Button variant="secondary" disabled={loading()} onClick={search}>
            {a().baseSearchAction}
          </Button>
          <Select
            label={a().base}
            value={options.selected ?? ""}
            selectedLabel={selectedLabel}
            options={[{ id: "", label: a().allBases }, ...choices()]}
            onValueChange={(value) => close(value || "")}
            disabled={loading()}
          />
          <div aria-live="polite">
            <Show when={loading()}>
              <InlineGuidance role="status" tone="info">
                {a().basesLoading}
              </InlineGuidance>
            </Show>
            <Show when={failed()}>
              <InlineGuidance role="alert" tone="danger">
                {a().basesFailed}
              </InlineGuidance>
            </Show>
            <Show when={!loading() && !failed() && !page()?.items.length}>
              <InlineGuidance role="status" tone="info">
                {page()?.next ? a().basesContinue : a().basesEmpty}
              </InlineGuidance>
            </Show>
          </div>
          <Show when={failed()}>
            <Button variant="secondary" onClick={() => void load(last, !!last.after)}>
              {a().retry}
            </Button>
          </Show>
          <Show when={page()?.next && !failed()}>
            <Button variant="secondary" disabled={loading()} onClick={() => void load({ ...last, after: page()!.next! }, true)}>
              {a().basesMore}
            </Button>
          </Show>
          <Button variant="secondary" onClick={cancel}>
            {a().cancel}
          </Button>
        </div>
      );
    },
    { title: options.title, size: "medium", history: true },
  );

type Preview =
  | { key: string; status: "counting" }
  | { key: string; status: "counted"; count: number }
  | { key: string; status: "limit" | "range" | "denied" | "failed" };

const CountSchema = z.object({ count: z.number().int().nonnegative() });
const FailureSchema = z.object({ code: z.string() }).partial();
/** 413 says which bound the request broke; everything else is a denial or a failure to try again. */
async function failureOf(response: { status: number; json: () => Promise<unknown> }): Promise<"limit" | "range" | "denied" | "failed"> {
  if (response.status === 401 || response.status === 403) return "denied";
  if (response.status !== 413) return "failed";
  const body = FailureSchema.safeParse(await response.json().catch(() => null));
  return body.success && body.data.code === "activity_export_range" ? "range" : "limit";
}
const queryOf = (input: ActivityExportInput) => ({
  format: input.format,
  from: input.from,
  to: input.to,
  ...(input.baseId ? { baseId: input.baseId } : {}),
  ...(input.actor ? { actor: input.actor } : {}),
  ...(input.action ? { action: input.action } : {}),
  ...(input.q ? { q: input.q } : {}),
});

function ExportHistoryDialog(
  props: ExportHistoryOptions & {
    close: () => void;
    setDismissHandler: Parameters<DialogRender<void>>[1]["setDismissHandler"];
  },
) {
  const a = useAdminHistoryMessages();
  const h = useHistoryMessages();
  const locale = useLocale();
  const period = defaultExportPeriod(props.filters.when, props.now);
  const [range, setRange] = createSignal<DateRangeValue>({ start: period.from, end: period.to });
  const [baseId, setBaseId] = createSignal(props.filters.baseId ?? "");
  const [baseLabels, setBaseLabels] = createSignal([...props.baseLabels]);
  const baseOptions = () => adminBaseOptions(baseLabels(), a(), locale());
  const chooseBase = async (value: string | null) => {
    if (value !== "search-bases") {
      setBaseId(value ?? "");
      return;
    }
    const picked = await openAdminBasePicker({
      bases: props.bases,
      selected: baseId() || undefined,
      labels: baseLabels(),
      title: a().base,
      load: async (input, signal) => {
        const page = await props.loadBases(input, signal);
        signal.throwIfAborted();
        setBaseLabels((known) => [...new Map([...known, ...page.items].map((base) => [base.bindingId, base])).values()]);
        return page;
      },
    });
    if (typeof picked === "string") setBaseId(picked);
  };
  const [format, setFormat] = createSignal<ExportFormat>("csv");
  const request = createMemo<ExportRequest>(() =>
    exportRequest({ from: range().start, to: range().end, baseId: baseId() || null, format: format() }, props.filters),
  );
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const [downloading, setDownloading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  let counting: AbortController | undefined;
  let download: AbortController | undefined;

  /** Counts exactly what a download would export now. A newer choice cancels the older count. */
  const count = (current: Extract<ExportRequest, { status: "ready" }>) => {
    counting?.abort();
    const controller = new AbortController();
    counting = controller;
    setPreview({ key: current.key, status: "counting" });
    void (async () => {
      try {
        const response = await apiClient.admin.activity.export.preview.$get(
          { query: queryOf(current.input) },
          { init: { signal: controller.signal } },
        );
        const body = response.ok ? CountSchema.safeParse(await response.json()) : null;
        if (controller.signal.aborted) return;
        if (body?.success) setPreview({ key: current.key, status: "counted", count: body.data.count });
        else setPreview({ key: current.key, status: body ? "failed" : await failureOf(response) });
      } catch {
        if (!controller.signal.aborted) setPreview({ key: current.key, status: "failed" });
      }
    })();
  };
  // Equal choices give an equal key; only a different key starts a new count.
  const requestKey = createMemo(() => {
    const current = request();
    return current.status === "ready" ? current.key : current.status;
  });
  createEffect(
    on(requestKey, () => {
      const current = request();
      setFailed(false);
      if (current.status === "ready") count(current);
      else {
        counting?.abort();
        setPreview(null);
      }
    }),
  );
  /** The count that belongs to the current choices; a count for earlier choices never enables a download. */
  const counted = () => {
    const current = request();
    const value = preview();
    return current.status === "ready" && value?.key === current.key ? value : null;
  };
  const rows = () => {
    const value = counted();
    return value?.status === "counted" ? value.count : null;
  };

  const cancel = () => {
    // A download already authorized stays in the audit log; cancelling only stops the transfer.
    counting?.abort();
    download?.abort();
    props.close();
  };
  props.setDismissHandler(cancel);
  onCleanup(() => {
    counting?.abort();
    download?.abort();
  });

  const start = async () => {
    const current = request();
    if (current.status !== "ready" || !rows() || downloading()) return;
    const controller = new AbortController();
    download = controller;
    setDownloading(true);
    setFailed(false);
    try {
      const response = await apiClient.admin.activity.export.$get(
        { query: queryOf(current.input) },
        { init: { signal: controller.signal } },
      );
      if (!response.ok) {
        const reason = await failureOf(response);
        if (controller.signal.aborted) return;
        // The export counts again; a changed count or lost right replaces the preview instead of a vague error.
        if (reason === "failed") setFailed(true);
        else setPreview({ key: current.key, status: reason });
        return;
      }
      // Only a complete body becomes a file. A cancelled or broken stream rejects here and nothing is saved.
      const file = await response.blob();
      if (controller.signal.aborted) return;
      downloadFileFromContent(file, exportFileName(current.input));
      toast.success(a().downloaded);
      props.close();
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (download === controller) download = undefined;
      setDownloading(false);
    }
  };

  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const primaryLabel = () => {
    const value = counted();
    if (value?.status === "counting") return a().counting;
    if (value?.status !== "counted") return a().exportButton;
    if (value.count === 0) return a().nothingToExport;
    return value.count === 1 ? a().exportOneRow : a().exportRows.replace("{count}", number(value.count));
  };
  const periodError = () => {
    const current = request();
    if (current.status === "missing") return a().periodMissing;
    return current.status === "range" || counted()?.status === "range" ? a().periodTooLong : undefined;
  };
  const kept = () => {
    const parts: string[] = [];
    if (props.filters.actor) parts.push(props.people[props.filters.actor] ?? h().selectedPerson);
    if (props.filters.action) parts.push(props.whatLabel(props.filters.action));
    if (props.filters.q) parts.push(a().filterSearch.replace("{q}", props.filters.q));
    return parts.length ? a().keptFilters.replace("{filters}", parts.join(", ")) : null;
  };

  return (
    <form
      class="filesv2-export-dialog flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <p class="text-sm text-muted">{a().exportDescription}</p>
      <DateRangePicker
        label={a().period}
        description={a().periodHint}
        error={periodError()}
        value={range}
        onValueChange={setRange}
        disabled={downloading()}
      />
      <Select
        label={a().base}
        value={baseId}
        onValueChange={(value) => void chooseBase(value)}
        options={[{ id: "", label: a().allBases }, ...baseOptions(), { id: "search-bases", label: a().baseSearchMore }]}
        selectedLabel={() => baseOptions().find((base) => base.value === baseId())?.label ?? a().unknownBase}
        disabled={downloading()}
      />
      <div class="flex flex-col items-start gap-1.5">
        <span class="text-sm font-medium">{a().format}</span>
        <SegmentedControl<ExportFormat>
          label={a().format}
          value={format}
          onValueChange={setFormat}
          disabled={downloading()}
          options={[
            { value: "csv", label: a().formatCsv },
            { value: "jsonl", label: a().formatJsonl },
          ]}
        />
        <p class="text-xs text-muted">{a().limitHint}</p>
      </div>
      <Show when={kept()}>{(text) => <p class="text-xs text-muted">{text()}</p>}</Show>
      <div aria-live="polite">
        <Show when={counted()?.status === "counted" && rows() === 0}>
          <InlineGuidance tone="info" role="status">
            {a().noRows}
          </InlineGuidance>
        </Show>
        <Show when={counted()?.status === "limit"}>
          <InlineGuidance tone="warning" role="alert">
            {a().tooMany}
          </InlineGuidance>
        </Show>
        <Show when={counted()?.status === "denied"}>
          <InlineGuidance tone="danger" role="alert">
            {a().denied}
          </InlineGuidance>
        </Show>
        <Show when={counted()?.status === "failed"}>
          <InlineGuidance tone="danger" role="alert">
            <span class="flex flex-wrap items-center justify-between gap-2">
              {a().countFailed}
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  const current = request();
                  if (current.status === "ready") count(current);
                }}
              >
                <i class="ti ti-refresh" aria-hidden="true" />
                {a().retry}
              </Button>
            </span>
          </InlineGuidance>
        </Show>
        <Show when={failed()}>
          <InlineGuidance tone="danger" role="alert">
            {a().exportFailed}
          </InlineGuidance>
        </Show>
      </div>
      <div class="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={cancel}>
          {a().cancel}
        </Button>
        {/* Counting keeps its words visible; a running download keeps the button's size under the spinner. */}
        <Button type="submit" loading={downloading()} loadingLabel={a().exporting} disabled={!rows()}>
          <i class="ti ti-download" aria-hidden="true" />
          {primaryLabel()}
        </Button>
      </div>
    </form>
  );
}
