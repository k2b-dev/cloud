import { query } from "@k2b/stdlib/solid";
import {
  Button,
  DescriptionList,
  DetailPanel,
  dialogCore,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  StatusBadge,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import type { PublicRecordRevision, PublicRecordRevisionPage } from "../../../api/durable-history";
import { recordMessages } from "./messages";

export const RECORD_VERSION_PAGE_SIZE = 5;

const valueLabel = (value: unknown, empty: string): string => {
  if (value === null || value === undefined || value === "") return empty;
  if (Array.isArray(value)) return value.length === 0 ? empty : value.map((item) => valueLabel(item, empty)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const readError = async (response: Response, fallback: string): Promise<string> => {
  const body = await response.json().catch(() => null);
  return body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : fallback;
};

const endpoint = (tableId: string, recordId: string) =>
  `/api/grids/records/${encodeURIComponent(tableId)}/${encodeURIComponent(recordId)}/versions?limit=${RECORD_VERSION_PAGE_SIZE}`;

const openRevision = (props: { tableId: string; recordId: string; revision: PublicRecordRevision }) =>
  dialogCore.open<void>((close) => {
    const locale = useLocale();
    const t = () => recordMessages.resolve([locale()]).t;
    const actionLabel: Record<PublicRecordRevision["action"], string> = {
      baseline: t().historyStarted,
      created: t().recordCreated,
      updated: t().recordUpdated,
      deleted: t().movedToTrash,
      restored: t().recordRestored,
      finalized: t().recordFinalized,
      "file.added": t().fileAdded,
      "file.replaced": t().fileReplaced,
      "file.removed": t().fileRemoved,
    };
    const fieldsById = new Map(props.revision.fields.map((field) => [field.id, field]));
    const values = Object.entries(props.revision.data)
      .map(([fieldId, value]) => ({ field: fieldsById.get(fieldId), value }))
      .filter((entry) => entry.field && entry.field.type !== "file")
      .sort((a, b) => (a.field?.position ?? 0) - (b.field?.position ?? 0));
    return (
      <PanelDialog>
        <PanelDialog.Header
          title={t().version({ revision: props.revision.revision })}
          subtitle={actionLabel[props.revision.action]}
          icon="ti ti-history"
          close={close}
        />
        <PanelDialog.Body>
          <PanelDialog.Section title={t().versionSection} icon="ti ti-clock-record">
            <DescriptionList
              layout="rows"
              size="sm"
              items={[
                { term: t().recorded, description: new Date(props.revision.createdAt).toLocaleString(locale()) },
                { term: t().actor, description: props.revision.actorDisplayName ?? t().systemActor },
                { term: t().recordState, description: props.revision.deletedAt ? t().inTrash : t().active },
              ]}
            />
          </PanelDialog.Section>
          <PanelDialog.Section title={t().fields} icon="ti ti-list-details">
            <DescriptionList
              layout="rows"
              size="sm"
              items={values.map(({ field, value }) => ({ term: field!.name, description: valueLabel(value, t().empty) }))}
            />
          </PanelDialog.Section>
          <Show when={props.revision.files.length > 0}>
            <PanelDialog.Section title={t().files} icon="ti ti-paperclip">
              <For each={props.revision.files}>
                {(file) => (
                  <DetailPanel.Action
                    href={`/api/grids/records/${encodeURIComponent(props.tableId)}/${encodeURIComponent(props.recordId)}/versions/${encodeURIComponent(props.revision.id)}/files/${encodeURIComponent(file.id)}`}
                    navigation="document"
                    download={file.filename}
                    title={file.filename}
                    description={`${new Intl.NumberFormat(locale(), { maximumFractionDigits: file.sizeBytes < 1024 ? 1 : 0 }).format(file.sizeBytes / 1024)} KiB`}
                    leading={<i class="ti ti-file" aria-hidden="true" />}
                    trailing={<i class="ti ti-download" aria-hidden="true" />}
                  />
                )}
              </For>
            </PanelDialog.Section>
          </Show>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <span />
          <Button variant="secondary" size="sm" onClick={() => close()}>
            {t().close}
          </Button>
        </PanelDialog.Footer>
      </PanelDialog>
    );
  }, panelDialogOptions);

export default function RecordVersions(props: { tableId: string; recordId: string }) {
  const locale = useLocale();
  const t = () => recordMessages.resolve([locale()]).t;
  const actionLabel = (): Record<PublicRecordRevision["action"], string> => ({
    baseline: t().historyStarted,
    created: t().recordCreated,
    updated: t().recordUpdated,
    deleted: t().movedToTrash,
    restored: t().recordRestored,
    finalized: t().recordFinalized,
    "file.added": t().fileAdded,
    "file.replaced": t().fileReplaced,
    "file.removed": t().fileRemoved,
  });
  const [mounted, setMounted] = createSignal(false);
  const pages = query.createInfinite<string, PublicRecordRevisionPage, string>({
    source: () => endpoint(props.tableId, props.recordId),
    enabled: mounted,
    loadPage: async (source, { cursor, abortSignal }) => {
      const url = new URL(source, window.location.origin);
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetch(`${url.pathname}${url.search}`, { headers: { Accept: "application/json" }, signal: abortSignal });
      if (!response.ok) throw new Error(await readError(response, t().versionsFailed));
      return response.json() as Promise<PublicRecordRevisionPage>;
    },
    getNextCursor: (page) => page.nextCursor ?? undefined,
  });
  const status = createMemo(() => pages.pages()[0]?.status ?? null);
  const enabledStatus = createMemo(() => {
    const value = status();
    return value?.enabled ? value : null;
  });
  const revisions = createMemo(() => pages.pages().flatMap((page) => page.items));
  onMount(() => setMounted(true));

  return (
    <Show when={status()?.enabled !== false}>
      <DetailPanel.Group label={t().recordVersions}>
        <DetailPanel.Section
          title={t().durableHistory}
          icon="ti ti-history"
          tone="accent"
          meta={
            enabledStatus() ? (
              <span class="flex items-center gap-2">
                <StatusBadge tone="ok" variant="text" label={t().on} />
                <Show when={revisions().length > 0}>{revisions().length}</Show>
              </span>
            ) : undefined
          }
          description={
            enabledStatus() ? t().historyProvable({ date: new Date(enabledStatus()!.activatedAt).toLocaleString(locale()) }) : undefined
          }
        >
          <div class="flex flex-col gap-2">
            <Show when={pages.loading() && revisions().length === 0}>
              <Placeholder align="left" class="px-0 py-2" description={<>{t().loadingVersions}</>} />
            </Show>
            <Show when={pages.error()}>
              {(error) => (
                <div class="flex items-center gap-2 text-sm text-danger" role="alert">
                  <span>{error().message}</span>
                  <Button size="xs" variant="ghost" onClick={() => void pages.invalidate()}>
                    {t().retry}
                  </Button>
                </div>
              )}
            </Show>
            <For each={revisions()}>
              {(revision) => {
                const names = new Map(revision.fields.map((field) => [field.id, field.name]));
                const changed = revision.changedFieldIds.flatMap((fieldId) => (names.get(fieldId) ? [names.get(fieldId)!] : [])).join(", ");
                return (
                  <DetailPanel.Action
                    onClick={() => void openRevision({ tableId: props.tableId, recordId: props.recordId, revision })}
                    title={`${t().version({ revision: revision.revision })} · ${actionLabel()[revision.action]}`}
                    description={`${changed ? `${changed} · ` : ""}${revision.actorDisplayName ?? t().systemActor} · ${new Date(revision.createdAt).toLocaleString(locale())}`}
                    leading={<i class="ti ti-history" aria-hidden="true" />}
                    trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
                  />
                );
              }}
            </For>
            <Show when={pages.hasMore()}>
              <Button
                variant="ghost"
                size="sm"
                class="w-fit"
                loading={pages.loadingMore()}
                loadingLabel={t().loadingMore}
                onClick={() => void pages.loadMore()}
              >
                {t().loadingMore}
              </Button>
            </Show>
          </div>
        </DetailPanel.Section>
      </DetailPanel.Group>
    </Show>
  );
}
