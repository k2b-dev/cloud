import { query } from "@k2b/stdlib/solid";
import { type DetailLinkItem, DetailLinks, DetailPanel, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, on, onMount, Show } from "solid-js";
import { recordMessages } from "./messages";

export type ReferencedByItem = {
  sourceTableId: string;
  sourceTableName: string;
  sourceRecordId: string;
  sourceRecordLabel: string;
  relationFieldId: string;
  relationFieldName: string;
};

export type ReferencedByPage = { items: ReferencedByItem[]; nextCursor: string | null };
type ReferencedByGroup = { tableName: string; fieldName: string; items: ReferencedByItem[] };
export const REFERENCED_BY_PAGE_SIZE = 5;

export const referencedByEndpoint = (tableId: string, recordId: string) =>
  `/api/grids/records/${encodeURIComponent(tableId)}/${encodeURIComponent(recordId)}/referenced-by?limit=${REFERENCED_BY_PAGE_SIZE}`;

export const groupReferencedByItems = (items: readonly ReferencedByItem[]): ReferencedByGroup[] => {
  const deduped = new Map<string, ReferencedByItem>();
  for (const item of items) deduped.set(`${item.sourceRecordId}:${item.relationFieldId}`, item);
  const grouped = new Map<string, ReferencedByGroup>();
  for (const item of deduped.values()) {
    const key = `${item.sourceTableId}:${item.relationFieldId}`;
    const group = grouped.get(key) ?? { tableName: item.sourceTableName, fieldName: item.relationFieldName, items: [] };
    group.items.push(item);
    grouped.set(key, group);
  }
  return [...grouped.values()];
};

export const referencedByActionTitle = (item: ReferencedByItem): string => `${item.relationFieldName} · ${item.sourceRecordLabel}`;

const readError = async (response: Response, fallback: string): Promise<string> => {
  const body = await response.json().catch(() => null);
  return body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : fallback;
};

/**
 * The record's links in one section (UI-27): what it points to through its relation fields ("Links to") and the
 * records that point to it ("Linked from"). The incoming side loads in bounded cursor pages after the first paint;
 * every loaded row stays visible, as the reverse relations always were, and "Load more" reads the next page.
 */
export default function RecordReferencedBy(props: {
  baseId: string;
  tableId: string;
  recordId: string;
  outgoing?: readonly DetailLinkItem[];
  /** The first page from the server, so both directions are there in the first paint and nothing moves. */
  initialPage?: ReferencedByPage | null;
  /** Changes with every fresh detail of the same record; the loaded pages then refresh in place. */
  revision?: unknown;
}) {
  const locale = useLocale();
  const t = () => recordMessages.resolve([locale()]).t;
  const [mounted, setMounted] = createSignal(false);
  const endpoint = () => referencedByEndpoint(props.tableId, props.recordId);
  const pages = query.createInfinite<string, ReferencedByPage, string>({
    source: endpoint,
    initial: props.initialPage ? { source: endpoint(), pages: [props.initialPage] } : undefined,
    enabled: mounted,
    loadPage: async (source, { cursor, abortSignal }) => {
      const url = new URL(source, window.location.origin);
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetch(`${url.pathname}${url.search}`, {
        headers: { Accept: "application/json" },
        signal: abortSignal,
      });
      if (!response.ok) throw new Error(await readError(response, t().loadReferencesFailed));
      return response.json() as Promise<ReferencedByPage>;
    },
    getNextCursor: (page) => page.nextCursor ?? undefined,
  });
  // A row keeps its object while its content stays the same, so refreshes and "Load more" keep its DOM and focus.
  const rows = new Map<string, DetailLinkItem>();
  const incoming = createMemo((): DetailLinkItem[] => {
    const list = groupReferencedByItems(pages.pages().flatMap((page) => page.items)).flatMap((group) =>
      group.items.map((item) => {
        const row = {
          id: `${item.sourceRecordId}:${item.relationFieldId}`,
          title: referencedByActionTitle(item),
          description: item.sourceTableName,
          icon: "ti ti-table-row",
          href: `/app/grids/${encodeURIComponent(props.baseId)}/table/${encodeURIComponent(item.sourceTableId)}?record=${encodeURIComponent(item.sourceRecordId)}`,
        };
        const kept = rows.get(row.id);
        if (kept && kept.title === row.title && kept.description === row.description && kept.href === row.href) return kept;
        rows.set(row.id, row);
        return row;
      }),
    );
    // Rows that left the loaded pages leave the cache too.
    const present = new Set(list.map((row) => row.id));
    for (const id of rows.keys()) if (!present.has(id)) rows.delete(id);
    return list;
  });
  // A fresh detail of the open record refreshes the loaded pages in place; the rows stay until the answer is there.
  createEffect(
    on(
      () => props.revision,
      // An invalidation always gets a request that covers it, also when one is still running for an older detail.
      () => void pages.invalidate().catch(() => undefined),
      { defer: true },
    ),
  );
  onMount(() => setMounted(true));

  return (
    <DetailLinks
      incoming={incoming()}
      outgoing={props.outgoing ?? []}
      limit={Number.POSITIVE_INFINITY}
      state={pages.error() ? "error" : pages.pages().length === 0 ? "loading" : "ready"}
      onRetry={() => void pages.invalidate()}
      footer={
        <>
          {/* What the server said about a failed page, and that no record points here, stay in words. */}
          <Show when={pages.error()?.message}>{(message) => <p class="k2b-detail-section-note">{message()}</p>}</Show>
          <Show when={!pages.error() && pages.pages().length > 0 && incoming().length === 0}>
            <p class="k2b-detail-section-note">{t().noReferences}</p>
          </Show>
          <Show when={pages.hasMore() && !pages.error()}>
            <DetailPanel.Action
              type="button"
              leading={<i class={pages.loadingMore() ? "ti ti-loader-2 animate-spin" : "ti ti-dots"} aria-hidden="true" />}
              title={t().loadingMore}
              disabled={pages.loadingMore() || pages.refreshing()}
              onClick={() => void pages.loadMore()}
            />
          </Show>
        </>
      }
    />
  );
}

/**
 * The record's Links section in the record panel. Until the record's detail, which brings the first page of reverse
 * relations, is there, the section holds its place with one loading row; then both directions appear together, so no
 * row that was already visible moves.
 */
export function RecordLinks(props: {
  baseId: string;
  tableId: string;
  recordId: string;
  outgoing?: readonly DetailLinkItem[];
  /** Whether the record's detail has arrived; its first page of reverse relations may still be `null`. */
  ready: boolean;
  initialPage?: ReferencedByPage | null;
  /** Changes with every fresh detail of the same record, such as after a live update. */
  revision?: unknown;
}) {
  return (
    <Show when={props.ready} fallback={<DetailLinks incoming={[]} outgoing={[]} state="loading" />}>
      <RecordReferencedBy
        baseId={props.baseId}
        tableId={props.tableId}
        recordId={props.recordId}
        outgoing={props.outgoing}
        initialPage={props.initialPage}
        revision={props.revision}
      />
    </Show>
  );
}
