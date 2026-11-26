import { prompts, toast, useLocale } from "@k2b/ui";
import { Bar, Button, Chip, Failed, Icon, Inline, Notice, type OnNavigate, Pane, StatusRow, Table, Text } from "@k2b/ui/v2";
import { createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { BaseSummary, TrashEntry } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { entryIcon } from "./entry-icon";
import { apiFailure } from "./file-preview";
import { useFilesMessages } from "./messages";
import { useTrashMessages } from "./trash-messages";

export type TrashPage = { entries: TrashEntry[]; next: string | null };

/**
 * The trash of one storage on v2: what was deleted, from where and when, each with Restore. Permanent deletion belongs to
 * the administration. The server reads the first page; further pages load here and add to it.
 */
export default function TrashPane(props: {
  base: BaseSummary;
  /** The server's first page, or null when it could not be read. */
  initial: TrashPage | null;
  timeZone: string;
  onRestored: (path: string) => void;
  onNavigate: OnNavigate;
}) {
  const b = useBrowserMessages();
  const t = useFilesMessages();
  const text = useTrashMessages();
  const locale = useLocale();
  const [page, setPage] = createSignal<TrashPage | null>(props.initial);
  const [loading, setLoading] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());
  const date = () => new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: props.timeZone });

  /** Reads a page; `after` adds it to the loaded entries, without it the list starts again. */
  const load = async (after?: string) => {
    setLoading(true);
    try {
      const response = await apiClient.bases[":baseId"].trash.$get(
        { param: { baseId: props.base.id }, query: after ? { after } : {} },
        { init: { signal: lifetime.signal } },
      );
      if (!response.ok) await apiFailure(response, t().unavailable);
      const result = await response.json();
      const before = after ? (page()?.entries ?? []) : [];
      const entries = [...new Map([...before, ...result.entries].map((entry) => [entry.id, entry])).values()];
      setPage({ entries, next: result.next });
    } catch (error) {
      if (lifetime.signal.aborted) return;
      if (after) toast.error(error instanceof Error ? error.message : t().unavailable);
      else setPage(null);
    } finally {
      setLoading(false);
    }
  };

  const restore = async (entry: TrashEntry) => {
    if (busy()) return;
    setBusy(entry.id);
    try {
      // k2b-ui gap: v2 has no form dialog yet in Files; the v1 prompt asks for the place (Files PR 3).
      const values = await prompts.form({
        title: b().restore,
        signal: lifetime.signal,
        fields: {
          path: {
            type: "text",
            label: text().restorePath,
            description: text().restoreHint,
            default: entry.original ?? entry.name,
            required: true,
            maxLength: 4096,
          },
        },
      });
      if (!values) return;
      const response = await apiClient.bases[":baseId"].trash[":id"].restore.$post(
        { param: { baseId: props.base.id, id: entry.id }, query: { path: values.path } },
        { init: { signal: lifetime.signal } },
      );
      if (!response.ok) await apiFailure(response, t().unavailable);
      const result = await response.json();
      toast.success(b().restored(entry.name));
      props.onRestored(result.entry.path);
    } catch (error) {
      if (lifetime.signal.aborted) return;
      toast.error(error instanceof Error ? error.message : t().unavailable);
      void load();
    } finally {
      setBusy(null);
    }
  };

  const unresolved = (entry: TrashEntry) => entry.state === "pending" || entry.state === "restoring";
  const place = (entry: TrashEntry) => (entry.original ? `/${entry.original}` : text().unknownOriginal);
  const deleted = (entry: TrashEntry) => (entry.deletedAt ? date().format(new Date(entry.deletedAt)) : text().unknownDate);

  return (
    <Pane
      label={b().trashTitle}
      scrollKey={`filesv2-trash:${props.base.id}`}
      status={
        <StatusRow
          lead={page() ? b().v2TrashCount({ count: page()!.entries.length, more: page()!.next ? "+" : "" }) : b().trashTitle}
          loading={loading()}
          facts={[{ after: b().trashDescription }]}
        />
      }
    >
      <Show when={page()?.entries.some(unresolved)}>
        <Notice tone="warn">{text().unresolved}</Notice>
      </Show>
      <Show when={page()} fallback={<Failed text={b().loadFailed} onRetry={() => void load()} />}>
        {(shown) => (
          <>
            <Table
              label={b().trashTitle}
              rows={shown().entries}
              rowKey={(entry) => entry.id}
              // Opening a deleted entry asks where to restore it; on the phone that is its one deed.
              open={(entry) => ({ onOpen: () => void restore(entry) })}
              empty={{ icon: "trash", text: b().trashEmpty }}
              phone={(entry) => ({
                lines: [entry.name, place(entry)],
                time: deleted(entry),
                marks: unresolved(entry) ? <Chip status="warn">{b().v2Unresolved}</Chip> : undefined,
              })}
              columns={[
                {
                  title: t().name,
                  width: { min: 200, default: 280 },
                  cell: (entry) => ({
                    lines: [
                      <Inline>
                        <Icon name={entryIcon(entry)} />
                        <Text>{entry.name}</Text>
                      </Inline>,
                      place(entry),
                    ],
                  }),
                },
                { title: b().v2Deleted, width: { min: 150, default: 220 }, drop: true, cell: deleted },
                // The state of an entry stands only while one is not finished; otherwise it would be an empty column.
                ...(shown().entries.some(unresolved)
                  ? [
                      {
                        title: b().v2State,
                        width: { min: 110, default: 150 },
                        drop: true,
                        cell: (entry: TrashEntry) => (unresolved(entry) ? <Chip status="warn">{b().v2Unresolved}</Chip> : ""),
                      },
                    ]
                  : []),
                {
                  title: b().v2Deeds,
                  cell: (entry) => (
                    <Button
                      variant="text"
                      icon="arrow-back-up"
                      busy={busy() === entry.id}
                      disabled={Boolean(busy()) || entry.state === "pending"}
                      onClick={() => void restore(entry)}
                    >
                      {b().restore}
                    </Button>
                  ),
                },
              ]}
            />
            <Show when={shown().next}>
              {(next) => (
                <Bar
                  start={<Text type="meta">{b().v2TrashCount({ count: shown().entries.length, more: "+" })}</Text>}
                  end={
                    <Button icon="chevron-down" busy={loading()} onClick={() => void load(next())}>
                      {b().loadMore}
                    </Button>
                  }
                />
              )}
            </Show>
          </>
        )}
      </Show>
    </Pane>
  );
}
