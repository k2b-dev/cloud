import { fileIcons } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  DetailPanel,
  Dropdown,
  isStructuredDataValue,
  Placeholder,
  prompts,
  StructuredDataPreview,
  toast,
} from "@k2b/ui";
import { createEffect, createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { openDocumentDetailsDialog } from "../documents/DocumentDetailsDialog";
import { openDocumentGenerateDialog } from "../documents/DocumentGenerateDialog";
import { downloadPdfResponse } from "../documents/document-download";
import { requestDocumentDownload } from "../documents/document-transfer-client";
import type {
  PublicDocument,
  PublicDocumentTemplateSummary,
  PublicRecordSnapshot,
  PublicRecordSnapshotSummary,
} from "../documents/public-document-types";
import { errorMessage } from "../utils/api-helpers";
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
  cloudUrl: string;
  tableId: string;
  tableName: string;
  recordId: string;
  live: boolean;
  templates: PublicDocumentTemplateSummary[];
  initialDocuments: { items: PublicDocument[]; cursor: string | null; hasMore: boolean };
  initialSnapshots: PublicRecordSnapshotSummary[];
}) {
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
    if (!res.ok) throw new Error(await errorMessage(res, "Failed to load generated documents"));
    return (await res.json()) as { items: PublicDocument[]; cursor: string | null; hasMore: boolean };
  };

  const loadSnapshots = async () => {
    const res = await apiClient.documents.snapshots["by-record"][":tableId"][":recordId"].$get({
      param: { tableId: props.tableId, recordId: props.recordId },
    });
    if (!res.ok) throw new Error(await errorMessage(res, "Failed to load snapshots"));
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
    onError: (error) => prompts.error(error.message),
  });

  const redownloadMut = mutations.create<void, PublicDocument>({
    onBefore: (document) => setActiveDownloadId(document.id),
    mutation: async (document) => {
      const res = await requestDocumentDownload(document.id);
      await downloadPdfResponse(res, document.filename);
    },
    onError: (error) => prompts.error(error.message),
    onFinally: () => setActiveDownloadId(null),
  });

  const createSnapshotMut = mutations.create<PublicRecordSnapshotSummary[], void>({
    mutation: async () => {
      const createRes = await apiClient.documents.snapshots["by-record"][":tableId"][":recordId"].$post({
        param: { tableId: props.tableId, recordId: props.recordId },
      });
      if (!createRes.ok) throw new Error(await errorMessage(createRes, "Failed to create snapshot"));
      return loadSnapshots();
    },
    onSuccess: (items) => {
      setSnapshots(items);
      toast.success("Snapshot created.");
    },
    onError: (error) => prompts.error(error.message),
  });

  const inspectSnapshotMut = mutations.create<void, PublicRecordSnapshotSummary>({
    onBefore: (snapshot) => setActiveSnapshotId(snapshot.id),
    mutation: async (summary) => {
      const res = await apiClient.documents.snapshots[":snapshotId"].$get({ param: { snapshotId: summary.id } });
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to load snapshot"));
      const snapshot = (await res.json()) as PublicRecordSnapshot;
      const root = snapshot.root as SnapshotRecordNode;
      const fields = snapshotFields(root, snapshot.tableId);
      const snapshotRecord = snapshotGridRecord(snapshot);
      const relationLabels = snapshotRelationLabels(snapshot);
      await prompts.dialog<void>(
        () => (
          <div class="h-[70vh] min-h-0">
            <RecordReadView
              cloudUrl={props.cloudUrl}
              baseId={snapshot.baseId}
              tableId={snapshot.tableId}
              tableName={snapshotTableName(snapshot)}
              fields={fields}
              record={snapshotRecord}
              mode="snapshot"
              relationLabels={relationLabels}
              headerMeta={
                <div class="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-dimmed">
                  <span class="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400">
                    <i class="ti ti-camera" /> snapshot
                  </span>
                  <span>·</span>
                  <span class="truncate">{snapshotTableName(snapshot)}</span>
                  <span>·</span>
                  <span>{formatRecordRelativeTime(snapshot.createdAt)}</span>
                  <span>·</span>
                  <span class="font-mono">{snapshotRecord.id.slice(0, 8)}</span>
                </div>
              }
            >
              <DetailPanel.Group label="Snapshot metadata">
                <DetailPanel.Section title="Metadata" icon="ti ti-info-circle">
                  <StructuredDataPreview
                    data={{
                      id: snapshot.id,
                      tableId: snapshot.tableId,
                      recordId: snapshot.recordId,
                      createdAt: snapshot.createdAt,
                      createdBy: snapshot.createdBy,
                    }}
                    maxRows={8}
                  />
                </DetailPanel.Section>
              </DetailPanel.Group>
              <DetailPanel.Group label="Raw snapshot data">
                <DetailPanel.Section title="Raw snapshot data" icon="ti ti-code" collapsible>
                  <div class="flex flex-col gap-3">
                    <StructuredDataPreview
                      title="Root record"
                      data={isStructuredDataValue(snapshot.root) ? snapshot.root : { error: "Snapshot root is not valid JSON." }}
                      defaultMode="raw"
                    />
                    <StructuredDataPreview
                      title="Record graph"
                      data={isStructuredDataValue(snapshot.graph) ? snapshot.graph : { error: "Snapshot graph is not valid JSON." }}
                      defaultMode="raw"
                    />
                  </div>
                </DetailPanel.Section>
              </DetailPanel.Group>
            </RecordReadView>
          </div>
        ),
        { title: "Record snapshot", icon: "ti ti-camera", size: "large" },
      );
    },
    onError: (error) => prompts.error(error.message),
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
    const template = props.templates.find((candidate) => candidate.id === document.templateId);
    void openDocumentDetailsDialog({
      document,
      canWrite: props.live && availableTemplates().length > 0,
      onDownload: (item) => redownloadMut.mutate(item),
      ...(template ? { onGenerateAgain: () => generate(template) } : {}),
    });
  };
  const generationActions = () =>
    availableTemplates().map((template) => ({
      label: template.name,
      icon: "ti ti-file-type-pdf",
      action: () => void generate(template),
    }));

  return (
    <>
      <Show when={props.live || manualSnapshots().length > 0}>
        <DetailPanel.Group label="Record snapshots">
          <DetailPanel.Section
            title="Snapshots"
            icon="ti ti-camera"
            meta={manualSnapshots().length}
            actions={
              <Show when={props.live}>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={() => createSnapshotMut.mutate(undefined)}
                  disabled={createSnapshotMut.loading()}
                  aria-busy={createSnapshotMut.loading()}
                >
                  {createSnapshotMut.loading() ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-camera" />}
                  Create snapshot
                </Button>
              </Show>
            }
          >
            <Show when={manualSnapshots().length === 0}>
              <Placeholder align="left" description="No snapshots yet." />
            </Show>
            <For each={manualSnapshots()}>
              {(snapshot) => (
                <DetailPanel.Action
                  type="button"
                  title={`SNAP-${snapshot.id.slice(0, 8).toUpperCase()}`}
                  description={formatRecordRelativeTime(snapshot.createdAt)}
                  leading={
                    <i aria-hidden="true" class={activeSnapshotId() === snapshot.id ? "ti ti-loader-2 animate-spin" : "ti ti-camera"} />
                  }
                  trailing={<i aria-hidden="true" class="ti ti-chevron-right" />}
                  aria-label={`Inspect snapshot ${snapshot.id}`}
                  onClick={() => inspectSnapshotMut.mutate(snapshot)}
                  disabled={inspectSnapshotMut.loading()}
                  aria-busy={activeSnapshotId() === snapshot.id}
                />
              )}
            </For>
          </DetailPanel.Section>
        </DetailPanel.Group>
      </Show>

      <Show when={generatedDocuments().length > 0 || (props.live && availableTemplates().length > 0)}>
        <DetailPanel.Group label="Generated documents">
          <DetailPanel.Section
            title="Documents"
            icon="ti ti-file-type-pdf"
            meta={hasMoreDocuments() ? `${generatedDocuments().length}+` : generatedDocuments().length}
            actions={
              <Show when={props.live && availableTemplates().length > 0}>
                <Dropdown.Root position="bottom-left" width="16rem" items={generationActions()}>
                  <Dropdown.Trigger variant="secondary" size="sm" type="button" disabled={refreshDocumentsMut.loading()}>
                    <i class="ti ti-file-plus" />
                    Generate
                    <i class="ti ti-chevron-down text-xs" />
                  </Dropdown.Trigger>
                </Dropdown.Root>
              </Show>
            }
          >
            <Show when={generatedDocuments().length === 0}>
              <Placeholder align="left" description="No generated documents yet." />
            </Show>
            <For each={generatedDocuments()}>
              {(document) => (
                <DetailPanel.Action
                  type="button"
                  title={document.filename}
                  description={formatRecordRelativeTime(document.createdAt)}
                  leading={
                    <i
                      aria-hidden="true"
                      class={
                        activeDownloadId() === document.id
                          ? "ti ti-loader-2 animate-spin"
                          : `ti ${fileIcons.getFileIcon({
                              name: document.filename,
                              type: "file",
                              mimeType: "application/pdf",
                            })}`
                      }
                    />
                  }
                  trailing={<i aria-hidden="true" class="ti ti-chevron-right" />}
                  aria-label={`Open ${document.filename}`}
                  onClick={() => inspectDocument(document)}
                />
              )}
            </For>
            <Show when={hasMoreDocuments()}>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                class="mt-2"
                loading={loadMoreDocumentsMut.loading()}
                loadingLabel="Loading documents"
                onClick={() => loadMoreDocumentsMut.mutate(undefined)}
              >
                Load more
              </Button>
            </Show>
          </DetailPanel.Section>
        </DetailPanel.Group>
      </Show>
    </>
  );
}
