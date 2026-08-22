import {
  Button,
  DataTable,
  type DataTableColumn,
  dialogCore,
  IconButton,
  PanelDialog,
  panelDialogWideOptions,
  Placeholder,
  StatusBadge,
  type StatusTone,
} from "@k2b/ui";
import type { AiMemoryLearningChange, AiMemoryLearningRun } from "@valentinkolb/cloud/ai";
import { createMemo, createResource, createSignal, Show } from "solid-js";
import { assistantApi } from "../api/client";
import { assistantConversationHref } from "./assistant-navigation";

const PAGE_SIZE = 20;

const STATUS: Record<AiMemoryLearningRun["status"], { label: string; tone: StatusTone }> = {
  running: { label: "Running", tone: "running" },
  ok: { label: "Learned", tone: "ok" },
  skipped: { label: "No changes", tone: "neutral" },
  failed: { label: "Failed", tone: "error" },
};

const ACTION: Record<AiMemoryLearningChange["action"], { label: string; tone: StatusTone }> = {
  added: { label: "Added", tone: "ok" },
  updated: { label: "Updated", tone: "running" },
  merged: { label: "Merged", tone: "neutral" },
  retired: { label: "Retired", tone: "neutral" },
};

const formatTime = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const formatDuration = (durationMs: number | null): string => {
  if (durationMs === null) return "–";
  return durationMs >= 1_000 ? `${(durationMs / 1_000).toFixed(1)}s` : `${durationMs}ms`;
};

const changeSummary = (run: AiMemoryLearningRun): string => {
  const parts = [
    run.addedCount ? `${run.addedCount} added` : "",
    run.updatedCount ? `${run.updatedCount} updated` : "",
    run.mergedCount ? `${run.mergedCount} merged` : "",
    run.retiredCount ? `${run.retiredCount} retired` : "",
  ].filter(Boolean);
  return parts.join(" · ") || "No changes";
};

const detailColumns: DataTableColumn<AiMemoryLearningChange>[] = [
  { id: "action", header: "Change", value: "action" },
  { id: "kind", header: "Type", value: "kind" },
  { id: "content", header: "Memory", value: "content" },
  {
    id: "resource",
    header: "Cloud resource",
    value: (change) => change.resourceRef ? `${change.resourceRef.type}:${change.resourceRef.id}` : "",
  },
  { id: "previousContent", header: "Previous value", value: "previousContent" },
];

const runKindLabel = (kind: AiMemoryLearningRun["kind"]): string => {
  if (kind === "workflow") return "Repeated workflow";
  return "Chat turn";
};

const memoryKindLabel = (kind: AiMemoryLearningChange["kind"]): string => {
  if (kind === "preference") return "Preference";
  if (kind === "workflow") return "Workflow";
  return "Fact";
};

function MemoryLearningRunDetails(props: { run: AiMemoryLearningRun; close: () => void }) {
  const status = () => STATUS[props.run.status];
  return (
    <PanelDialog>
      <PanelDialog.Header
        title="Learning run details"
        subtitle={formatTime(props.run.createdAt)}
        icon="ti ti-history"
        close={props.close}
        closeLabel="Close learning run details"
      />
      <PanelDialog.Body scrollPreserveKey={`assistant-memory-learning-${props.run.id}`}>
        <PanelDialog.Section
          title={props.run.conversationTitle}
          subtitle={`${runKindLabel(props.run.kind)} · ${changeSummary(props.run)} · ${props.run.accountedTokens.toLocaleString()} tokens · ${formatDuration(props.run.durationMs)}${
            props.run.modelProfileId ? ` · ${props.run.modelProfileId}` : ""
          }`}
          icon="ti ti-message-circle"
          actions={<StatusBadge label={status().label} tone={status().tone} />}
        >
          <Show when={props.run.error}>
            {(error) => <p class="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error()}</p>}
          </Show>
          <Show
            when={props.run.changes.length > 0}
            fallback={<Placeholder state="empty" title="No personalization changed" description="This run found nothing durable to save." />}
          >
            <DataTable
              rows={props.run.changes}
              columns={detailColumns}
              density="compact"
              surface="paper"
              ariaLabel="Memories changed by this learning run"
              renderCell={({ row, col, value, render }) => {
                if (col.id === "action") {
                  const action = ACTION[row.action];
                  return <StatusBadge label={action.label} tone={action.tone} variant="chip" />;
                }
                if (col.id === "kind") return memoryKindLabel(row.kind);
                return render(value);
              }}
            />
          </Show>
        </PanelDialog.Section>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button variant="secondary" size="sm" onClick={props.close}>Close</Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

const openRunDetails = (run: AiMemoryLearningRun): Promise<void | undefined> =>
  dialogCore.open<void>((close) => <MemoryLearningRunDetails run={run} close={() => close()} />, panelDialogWideOptions);

function MemoryLearningActivity(props: { close: () => void }) {
  const [page, setPage] = createSignal(1);
  const [activity, { refetch }] = createResource(page, (currentPage) =>
    assistantApi.listMemoryLearningRuns({ page: currentPage, perPage: PAGE_SIZE }),
  );
  const totalPages = createMemo(() => Math.max(1, Math.ceil((activity()?.total ?? 0) / PAGE_SIZE)));
  const columns: DataTableColumn<AiMemoryLearningRun>[] = [
    { id: "createdAt", header: "When", value: (run) => formatTime(run.createdAt) },
    { id: "kind", header: "Run", value: (run) => runKindLabel(run.kind) },
    { id: "conversation", header: "Evidence chat", value: "conversationTitle" },
    { id: "status", header: "Status", value: "status" },
    { id: "changes", header: "Changes", value: changeSummary },
    { id: "tokens", header: "Tokens", value: (run) => run.accountedTokens.toLocaleString(), align: "right" },
    { id: "duration", header: "Duration", value: (run) => formatDuration(run.durationMs), align: "right" },
    { id: "details", header: <span class="sr-only">Details</span> },
  ];

  return (
    <PanelDialog>
      <PanelDialog.Header
        title="Personalization learning activity"
        subtitle="See when Assistant learned from completed private-chat turns, consolidated workflows, and exactly what changed."
        icon="ti ti-history"
        close={props.close}
        closeLabel="Close personalization learning activity"
      />
      <PanelDialog.Body scrollPreserveKey="assistant-memory-learning-activity">
        <Show when={activity.loading}>
          <Placeholder state="loading" title="Loading learning activity" />
        </Show>
        <Show when={activity.error}>
          <Placeholder
            state="error"
            title="Could not load learning activity"
            description={activity.error.message}
            action={<Button size="xs" variant="secondary" onClick={() => void refetch()}>Retry</Button>}
          />
        </Show>
        <Show when={!activity.loading && !activity.error}>
          <DataTable
            rows={activity()?.runs ?? []}
            columns={columns}
            getRowId={(run) => run.id}
            density="compact"
            surface="paper"
            ariaLabel="Personalization learning runs"
            empty="No learning runs yet. Activity appears after Assistant checks a completed private-chat turn."
            renderCell={({ row, col, value, render }) => {
              if (col.id === "conversation") {
                return row.conversationId ? (
                  <a
                    class="font-medium text-primary hover:text-blue-600 hover:underline dark:hover:text-blue-400"
                    href={assistantConversationHref(globalThis.location?.href ?? "/app/assistant", row.conversationId)}
                  >
                    {row.conversationTitle}
                  </a>
                ) : row.conversationTitle;
              }
              if (col.id === "status") {
                const status = STATUS[row.status];
                return <StatusBadge label={status.label} tone={status.tone} variant="chip" />;
              }
              if (col.id === "details") {
                return (
                  <IconButton label={`View details for ${row.conversationTitle}`} title="View learning run details" onClick={() => void openRunDetails(row)}>
                    <i class="ti ti-info-circle" aria-hidden="true" />
                  </IconButton>
                );
              }
              return render(value);
            }}
          />
        </Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span class="mr-auto text-xs text-dimmed">
          {activity()?.total ?? 0} runs · Page {page()} of {totalPages()}
        </span>
        <Button variant="secondary" size="sm" disabled={page() <= 1 || activity.loading} onClick={() => setPage((value) => value - 1)}>
          <i class="ti ti-chevron-left" aria-hidden="true" /> Previous
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={page() >= totalPages() || activity.loading}
          onClick={() => setPage((value) => value + 1)}
        >
          Next <i class="ti ti-chevron-right" aria-hidden="true" />
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export const openAssistantMemoryLearningActivity = (): Promise<void | undefined> =>
  dialogCore.open<void>((close) => <MemoryLearningActivity close={() => close()} />, panelDialogWideOptions);
