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
  useLocale,
} from "@k2b/ui";
import type { AiMemoryLearningChange, AiMemoryLearningRun } from "@k2b/cloud/ai";
import { createMemo, createResource, createSignal, Show } from "solid-js";
import { assistantApi } from "../api/client";
import { assistantConversationHref } from "./assistant-navigation";
import { useAssistantText } from "./ui-copy";

const PAGE_SIZE = 20;

const formatTime = (iso: string, locale: string): string =>
  new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });

const formatDuration = (durationMs: number | null): string => {
  if (durationMs === null) return "–";
  return durationMs >= 1_000 ? `${(durationMs / 1_000).toFixed(1)}s` : `${durationMs}ms`;
};

const changeSummary = (run: AiMemoryLearningRun, text: (value: string) => string): string => {
  const parts = [
    run.addedCount ? `${run.addedCount} ${text("added")}` : "",
    run.updatedCount ? `${run.updatedCount} ${text("updated")}` : "",
    run.mergedCount ? `${run.mergedCount} ${text("merged")}` : "",
    run.retiredCount ? `${run.retiredCount} ${text("retired")}` : "",
  ].filter(Boolean);
  return parts.join(" · ") || text("No changes");
};

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
  const text = useAssistantText();
  const locale = useLocale();
  const detailColumns: DataTableColumn<AiMemoryLearningChange>[] = [
    { id: "action", header: text("Change"), value: "action" },
    { id: "kind", header: text("Type"), value: "kind" },
    { id: "content", header: text("Memory"), value: "content" },
    {
      id: "resource",
      header: text("Cloud resource"),
      value: (change) => change.resourceRef ? `${change.resourceRef.type}:${change.resourceRef.id}` : "",
    },
    { id: "previousContent", header: text("Previous value"), value: "previousContent" },
  ];
  const status = () => ({
    running: { label: text("Running"), tone: "running" as const },
    ok: { label: text("Learned"), tone: "ok" as const },
    skipped: { label: text("No changes"), tone: "neutral" as const },
    failed: { label: text("Failed"), tone: "error" as const },
  })[props.run.status];
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={text("Learning run details")}
        subtitle={formatTime(props.run.createdAt, locale())}
        icon="ti ti-history"
        close={props.close}
        closeLabel={text("Close learning run details")}
      />
      <PanelDialog.Body scrollPreserveKey={`assistant-memory-learning-${props.run.id}`}>
        <PanelDialog.Section
          title={props.run.conversationTitle}
          subtitle={`${text(runKindLabel(props.run.kind))} · ${changeSummary(props.run, text)} · ${props.run.accountedTokens.toLocaleString(locale())} ${text("tokens")} · ${formatDuration(props.run.durationMs)}${
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
            fallback={<Placeholder state="empty" title={text("No personalization changed")} description={text("This run found nothing durable to save.")} />}
          >
            <DataTable
              rows={props.run.changes}
              columns={detailColumns}
              density="compact"
              surface="paper"
              ariaLabel={text("Memories changed by this learning run")}
              renderCell={({ row, col, value, render }) => {
                if (col.id === "action") {
                  const action = {
                    added: { label: text("Added"), tone: "ok" as const },
                    updated: { label: text("Updated"), tone: "running" as const },
                    merged: { label: text("Merged"), tone: "neutral" as const },
                    retired: { label: text("Retired"), tone: "neutral" as const },
                  }[row.action];
                  return <StatusBadge label={action.label} tone={action.tone} variant="chip" />;
                }
                if (col.id === "kind") return text(memoryKindLabel(row.kind));
                return render(value);
              }}
            />
          </Show>
        </PanelDialog.Section>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button variant="secondary" size="sm" onClick={props.close}>{text("Close")}</Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

const openRunDetails = (run: AiMemoryLearningRun): Promise<void | undefined> =>
  dialogCore.open<void>((close) => <MemoryLearningRunDetails run={run} close={() => close()} />, panelDialogWideOptions);

function MemoryLearningActivity(props: { close: () => void }) {
  const text = useAssistantText();
  const locale = useLocale();
  const [page, setPage] = createSignal(1);
  const [activity, { refetch }] = createResource(page, (currentPage) =>
    assistantApi.listMemoryLearningRuns({ page: currentPage, perPage: PAGE_SIZE }),
  );
  const totalPages = createMemo(() => Math.max(1, Math.ceil((activity()?.total ?? 0) / PAGE_SIZE)));
  const columns: DataTableColumn<AiMemoryLearningRun>[] = [
    { id: "createdAt", header: text("When"), value: (run) => formatTime(run.createdAt, locale()) },
    { id: "kind", header: text("Run"), value: (run) => text(runKindLabel(run.kind)) },
    { id: "conversation", header: text("Evidence chat"), value: "conversationTitle" },
    { id: "status", header: text("Status"), value: "status" },
    { id: "changes", header: text("Changes"), value: (run) => changeSummary(run, text) },
    { id: "tokens", header: text("Tokens"), value: (run) => run.accountedTokens.toLocaleString(locale()), align: "right" },
    { id: "duration", header: text("Duration"), value: (run) => formatDuration(run.durationMs), align: "right" },
    { id: "details", header: <span class="sr-only">{text("Details")}</span> },
  ];

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={text("Personalization learning activity")}
        subtitle={text("See when Assistant learned from completed private-chat turns, consolidated workflows, and exactly what changed.")}
        icon="ti ti-history"
        close={props.close}
        closeLabel={text("Close personalization learning activity")}
      />
      <PanelDialog.Body scrollPreserveKey="assistant-memory-learning-activity">
        <Show when={activity.loading}>
          <Placeholder state="loading" title={text("Loading learning activity")} />
        </Show>
        <Show when={activity.error}>
          <Placeholder
            state="error"
            title={text("Could not load learning activity")}
            description={activity.error.message}
            action={<Button size="xs" variant="secondary" onClick={() => void refetch()}>{text("Retry")}</Button>}
          />
        </Show>
        <Show when={!activity.loading && !activity.error}>
          <DataTable
            rows={activity()?.runs ?? []}
            columns={columns}
            getRowId={(run) => run.id}
            density="compact"
            surface="paper"
            ariaLabel={text("Personalization learning runs")}
            empty={text("No learning runs yet. Activity appears after Assistant checks a completed private-chat turn.")}
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
                const status = {
                  running: { label: text("Running"), tone: "running" as const },
                  ok: { label: text("Learned"), tone: "ok" as const },
                  skipped: { label: text("No changes"), tone: "neutral" as const },
                  failed: { label: text("Failed"), tone: "error" as const },
                }[row.status];
                return <StatusBadge label={status.label} tone={status.tone} variant="chip" />;
              }
              if (col.id === "details") {
                return (
                  <IconButton label={`${text("View details for")} ${row.conversationTitle}`} title={text("View learning run details")} onClick={() => void openRunDetails(row)}>
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
          <i class="ti ti-chevron-left" aria-hidden="true" /> {text("Previous")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={page() >= totalPages() || activity.loading}
          onClick={() => setPage((value) => value + 1)}
        >
          {text("Next")} <i class="ti ti-chevron-right" aria-hidden="true" />
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export const openAssistantMemoryLearningActivity = (): Promise<void | undefined> =>
  dialogCore.open<void>((close) => <MemoryLearningActivity close={() => close()} />, panelDialogWideOptions);
