import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  announce,
  Button,
  DescriptionList,
  DetailPanel,
  Dropdown,
  FileGrid,
  FileTypeIcon,
  fileKindLabel,
  formatFileViewSize,
  IconButton,
  isStructuredDataValue,
  prompts,
  StructuredDataPreview,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createSignal, For, type JSX, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { openDocumentDetailsDialog } from "../documents/DocumentDetailsDialog";
import { openDocumentGenerateDialog } from "../documents/DocumentGenerateDialog";
import { downloadPdfResponse } from "../documents/document-download";
import { requestDocumentDownload } from "../documents/document-transfer-client";
import { documentMessages } from "../documents/messages";
import type {
  PublicDocument,
  PublicDocumentTemplateSummary,
  PublicRecordSnapshot,
  PublicRecordSnapshotSummary,
} from "../documents/public-document-types";
import { errorMessage } from "../utils/api-helpers";
import { createRetryToasts } from "../utils/feedback";
import { recordMessages } from "./messages";
import { formatRecordRelativeTime } from "./RecordHistorySection";
import RecordReadView from "./RecordReadView";
import {
  type SnapshotRecordNode,
  snapshotFields,
  snapshotGridRecord,
  snapshotRelationLabels,
  snapshotTableName,
} from "./record-snapshot-model";

export default function RecordDocumentsSection(props: {
  tableId: string;
  tableName: string;
  recordId: string;
  live: boolean;
  canWrite: boolean;
  templates: PublicDocumentTemplateSummary[];
  initialDocuments: { items: PublicDocument[]; cursor: string | null; hasMore: boolean };
  initialSnapshots: PublicRecordSnapshotSummary[];
  /** Places the generated documents with the record's files and the snapshots under "More about this record". */
  children?: (parts: { documents: JSX.Element; snapshots: JSX.Element }) => JSX.Element;
}) {
  const locale = useLocale();
  const t = () => recordMessages.resolve([locale()]).t;
  const retryToast = createRetryToasts();
  const dt = () => documentMessages.resolve([locale()]).t;
  const [documents, setDocuments] = createSignal<PublicDocument[]>(props.initialDocuments.items);
  const [documentCursor, setDocumentCursor] = createSignal(props.initialDocuments.cursor);
  const [hasMoreDocuments, setHasMoreDocuments] = createSignal(props.initialDocuments.hasMore);
  const [snapshots, setSnapshots] = createSignal<PublicRecordSnapshotSummary[]>(props.initialSnapshots);
  const [activeDownloadId, setActiveDownloadId] = createSignal<string | null>(null);
  const [activeSnapshotId, setActiveSnapshotId] = createSignal<string | null>(null);

  createEffect(() => {
    setDocuments(props.initialDocuments.items);
    setDocumentCursor(props.initialDocuments.cursor);
    setHasMoreDocuments(props.initialDocuments.hasMore);
  });
  createEffect(() => setSnapshots(props.initialSnapshots));

  const loadDocuments = async (cursor?: string | null) => {
    const res = await apiClient.documents["by-record"][":tableId"][":recordId"].$get({
      param: { tableId: props.tableId, recordId: props.recordId },
      query: { limit: "100", ...(cursor ? { cursor } : {}) },
    });
    if (!res.ok) throw new Error(await errorMessage(res, t().generatedDocumentsLoadFailed));
    return (await res.json()) as { items: PublicDocument[]; cursor: string | null; hasMore: boolean };
  };

  const loadSnapshots = async () => {
    const res = await apiClient.documents.snapshots["by-record"][":tableId"][":recordId"].$get({
      param: { tableId: props.tableId, recordId: props.recordId },
    });
    if (!res.ok) throw new Error(await errorMessage(res, t().snapshotsLoadFailed));
    return ((await res.json()) as { items: PublicRecordSnapshotSummary[] }).items;
  };

  const refreshDocumentsMut = mutations.create<
    { documents: { items: PublicDocument[]; cursor: string | null; hasMore: boolean }; snapshots: PublicRecordSnapshotSummary[] },
    void
  >({
    mutation: async () => {
      const [nextDocuments, nextSnapshots] = await Promise.all([loadDocuments(), loadSnapshots()]);
      return { documents: nextDocuments, snapshots: nextSnapshots };
    },
    onSuccess: (value) => {
      setDocuments(value.documents.items);
      setDocumentCursor(value.documents.cursor);
      setHasMoreDocuments(value.documents.hasMore);
      setSnapshots(value.snapshots);
    },
    // Runs while the generate dialog is still open, so the failure belongs in a dialog too.
    onError: (error) => prompts.error(error.message),
  });

  const loadMoreDocumentsMut = mutations.create<{ items: PublicDocument[]; cursor: string | null; hasMore: boolean }, void>({
    mutation: () => loadDocuments(documentCursor()),
    onSuccess: (page) => {
      const known = new Set(documents().map((document) => document.id));
      setDocuments((current) => [...current, ...page.items.filter((document) => !known.has(document.id))]);
      setDocumentCursor(page.cursor);
      setHasMoreDocuments(page.hasMore);
    },
    onError: (error) => retryToast(error.message, { retryLabel: t().retry, retry: () => loadMoreDocumentsMut.mutate() }),
  });

  const redownloadMut = mutations.create<void, PublicDocument>({
    onBefore: (document) => setActiveDownloadId(document.id),
    mutation: async (document) => {
      const res = await requestDocumentDownload(document.id);
      await downloadPdfResponse(res, document.filename);
    },
    // Runs from the open document details dialog, so the failure belongs in a dialog too.
    onError: (error) => prompts.error(error.message),
    onFinally: () => setActiveDownloadId(null),
  });

  const createSnapshotMut = mutations.create<PublicRecordSnapshotSummary[], void>({
    mutation: async () => {
      const createRes = await apiClient.documents.snapshots["by-record"][":tableId"][":recordId"].$post({
        param: { tableId: props.tableId, recordId: props.recordId },
      });
      if (!createRes.ok) throw new Error(await errorMessage(createRes, t().snapshotCreateFailed));
      return loadSnapshots();
    },
    // The new snapshot appears in the list; the button was busy while it was created, so a screen reader is told.
    onSuccess: (items) => {
      setSnapshots(items);
      announce(t().snapshotCreatedStatus);
    },
    onError: (error) => toast.error(error.message),
  });

  const inspectSnapshotMut = mutations.create<void, PublicRecordSnapshotSummary>({
    onBefore: (snapshot) => setActiveSnapshotId(snapshot.id),
    mutation: async (summary) => {
      const res = await apiClient.documents.snapshots[":snapshotId"].$get({ param: { snapshotId: summary.id } });
      if (!res.ok) throw new Error(await errorMessage(res, t().snapshotLoadFailed));
      const snapshot = (await res.json()) as PublicRecordSnapshot;
      const root = snapshot.root as SnapshotRecordNode;
      const fields = snapshotFields(root, snapshot.tableId);
      const snapshotRecord = snapshotGridRecord(snapshot);
      const relationLabels = snapshotRelationLabels(snapshot);
      await prompts.dialog<void>(
        () => (
          <div class="h-[70vh] min-h-0">
            <RecordReadView
              baseId={snapshot.baseId}
              tableId={snapshot.tableId}
              tableName={snapshotTableName(snapshot)}
              fields={fields}
              record={snapshotRecord}
              mode="snapshot"
              relationLabels={relationLabels}
              subtitle={t().snapshotFrom({ date: formatRecordRelativeTime(snapshot.createdAt) })}
              more={
                <>
                  <DetailPanel.Section title={t().metadata} collapsible summary={t().snapshotSummary}>
                    <DescriptionList
                      layout="rows"
                      size="sm"
                      items={[
                        { term: t().snapshot, description: <span class="block truncate">{snapshot.id}</span> },
                        { term: t().recordId, description: <span class="block truncate">{snapshot.recordId}</span> },
                        { term: t().created, description: new Date(snapshot.createdAt).toLocaleString(locale()) },
                        { term: t().createdBy, description: snapshot.createdBy ?? t().system },
                      ]}
                    />
                  </DetailPanel.Section>
                  <DetailPanel.Section title={t().rawSnapshotData} collapsible summary={`${t().rootRecord}, ${t().recordGraph}`}>
                    <div class="flex flex-col gap-3">
                      <StructuredDataPreview
                        title={t().rootRecord}
                        data={isStructuredDataValue(snapshot.root) ? snapshot.root : { error: t().invalidSnapshotRoot }}
                        defaultMode="raw"
                      />
                      <StructuredDataPreview
                        title={t().recordGraph}
                        data={isStructuredDataValue(snapshot.graph) ? snapshot.graph : { error: t().invalidSnapshotGraph }}
                        defaultMode="raw"
                      />
                    </div>
                  </DetailPanel.Section>
                </>
              }
            />
          </div>
        ),
        { title: t().recordSnapshot, icon: "ti ti-camera", size: "large" },
      );
    },
    onError: (error) => toast.error(error.message),
    onFinally: () => setActiveSnapshotId(null),
  });

  const generate = async (template: PublicDocumentTemplateSummary) => {
    await openDocumentGenerateDialog({
      template,
      table: { id: props.tableId, name: props.tableName },
      initialRecordId: props.recordId,
      onGenerated: async () => refreshDocumentsMut.mutate(undefined),
    });
  };

  const availableTemplates = () => props.templates.filter((template) => template.enabled);
  const generatedDocuments = documents;
  const manualSnapshots = snapshots;
  const inspectDocument = (document: PublicDocument) => {
    const template = availableTemplates().find((candidate) => candidate.id === document.templateId);
    void openDocumentDetailsDialog({
      document,
      templateName: props.templates.find((candidate) => candidate.id === document.templateId)?.name,
      canWrite: props.canWrite,
      onDownload: (item) => redownloadMut.mutate(item),
      ...(props.live && props.canWrite && template ? { onGenerateAgain: () => generate(template) } : {}),
    });
  };
  const generationActions = () =>
    availableTemplates().map((template) => ({
      label: template.name,
      icon: "ti ti-file-type-pdf",
      action: () => void generate(template),
    }));

  const primaryArtifact = (document: PublicDocument) =>
    document.artifacts.find((artifact) => artifact.key === document.primaryArtifactKey) ?? document.artifacts[0];
  const documentMeta = (document: PublicDocument) => {
    const artifact = primaryArtifact(document);
    return [
      fileKindLabel({ name: artifact?.filename ?? document.filename, mediaType: artifact?.mimeType }, locale()),
      artifact ? formatFileViewSize(artifact.sizeBytes, locale()) : null,
      formatRecordRelativeTime(document.createdAt),
      (document.sourceRecordCount ?? 0) > 1 ? dt().sourceRecordCount({ count: document.sourceRecordCount! }) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };
  const snapshotTitle = (snapshot: PublicRecordSnapshotSummary) => `SNAP-${snapshot.id.slice(0, 8).toUpperCase()}`;

  const documentsSection = (
    <Show when={generatedDocuments().length > 0 || (props.live && props.canWrite && availableTemplates().length > 0)}>
      <DetailPanel.Section
        title={t().documents}
        count={hasMoreDocuments() || generatedDocuments().length === 0 ? undefined : generatedDocuments().length}
        meta={hasMoreDocuments() ? `${generatedDocuments().length}+` : undefined}
        actions={
          <Show when={props.live && props.canWrite && availableTemplates().length > 0}>
            <Dropdown.Root position="bottom-left" width="16rem" items={generationActions()}>
              <Dropdown.Trigger variant="ghost" size="xs" type="button" disabled={refreshDocumentsMut.loading()}>
                <i class="ti ti-file-plus" aria-hidden="true" />
                {t().generate}
                <i class="ti ti-chevron-down text-xs" aria-hidden="true" />
              </Dropdown.Trigger>
            </Dropdown.Root>
          </Show>
        }
      >
        <Show when={generatedDocuments().length > 0} fallback={<p class="grids-details-none">{t().noGeneratedDocuments}</p>}>
          <FileGrid
            rows={generatedDocuments()}
            getRowId={(document) => document.id}
            label={t().generatedDocuments}
            layout="list"
            limit={5}
            actionVisibility="progressive"
            renderPreview={(document) => (
              <FileTypeIcon
                name={primaryArtifact(document)?.filename ?? document.filename}
                mediaType={primaryArtifact(document)?.mimeType}
              />
            )}
            renderLabel={(document) => document.filename}
            renderMeta={documentMeta}
            renderActions={(document) => (
              <Tooltip.Anchor content={t().downloadNamed({ name: document.filename })}>
                <IconButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  label={t().downloadNamed({ name: document.filename })}
                  aria-busy={activeDownloadId() === document.id || undefined}
                  disabled={activeDownloadId() === document.id}
                  onClick={() => redownloadMut.mutate(document)}
                >
                  <i class={activeDownloadId() === document.id ? "ti ti-loader-2 animate-spin" : "ti ti-download"} aria-hidden="true" />
                </IconButton>
              </Tooltip.Anchor>
            )}
            onOpen={inspectDocument}
          />
        </Show>
        <Show when={hasMoreDocuments()}>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            class="mt-2 w-fit"
            loading={loadMoreDocumentsMut.loading()}
            loadingLabel={t().loadingDocuments}
            onClick={() => loadMoreDocumentsMut.mutate(undefined)}
          >
            {t().loadMore}
          </Button>
        </Show>
      </DetailPanel.Section>
    </Show>
  );

  const snapshotsSection = (
    <Show when={props.live || manualSnapshots().length > 0}>
      <DetailPanel.Section
        title={t().snapshots}
        count={manualSnapshots().length || undefined}
        collapsible
        summary={
          manualSnapshots()[0]
            ? `${snapshotTitle(manualSnapshots()[0]!)} · ${formatRecordRelativeTime(manualSnapshots()[0]!.createdAt)}`
            : t().noSnapshots
        }
      >
        <For each={manualSnapshots()}>
          {(snapshot) => (
            <DetailPanel.Action
              type="button"
              title={snapshotTitle(snapshot)}
              description={formatRecordRelativeTime(snapshot.createdAt)}
              leading={<i aria-hidden="true" class={activeSnapshotId() === snapshot.id ? "ti ti-loader-2 animate-spin" : "ti ti-camera"} />}
              aria-label={t().inspectSnapshot({ id: snapshot.id })}
              onClick={() => inspectSnapshotMut.mutate(snapshot)}
              disabled={inspectSnapshotMut.loading()}
              aria-busy={activeSnapshotId() === snapshot.id}
            />
          )}
        </For>
        <Show when={manualSnapshots().length === 0}>
          <p class="grids-details-none">{t().noSnapshots}</p>
        </Show>
        <Show when={props.live}>
          <DetailPanel.Action
            type="button"
            class="grids-details-add"
            leading={<i aria-hidden="true" class={createSnapshotMut.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-camera-plus"} />}
            title={t().createSnapshot}
            onClick={() => createSnapshotMut.mutate(undefined)}
            disabled={createSnapshotMut.loading()}
            aria-busy={createSnapshotMut.loading()}
          />
        </Show>
      </DetailPanel.Section>
    </Show>
  );

  return (
    <Show
      when={props.children}
      fallback={
        <>
          {documentsSection}
          {snapshotsSection}
        </>
      }
    >
      {(render) => render()({ documents: documentsSection, snapshots: snapshotsSection })}
    </Show>
  );
}
