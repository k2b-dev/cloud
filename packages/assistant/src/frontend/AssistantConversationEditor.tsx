import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  confirmDiscardIfDirty,
  DataTable,
  type DataTableColumn,
  prompts,
  SettingsField,
  SettingsGroup,
  SettingsModal,
  SettingsPanelFooter,
  StatusBadge,
  type StatusTone,
  TextInput,
  toast,
} from "@k2b/ui";
import type { AiConversation, AiEnrichmentRun, AiEnrichmentStatus } from "@valentinkolb/cloud/ai";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { assistantApi } from "../api/client";
import { useAssistantCopy, useAssistantText } from "./ui-copy";

type EditConversationResult = { action: "save"; conversation: AiConversation } | { action: "archive"; conversation: AiConversation };

type EditConversationFormProps = {
  conversation: AiConversation;
  archiveDisabled?: boolean;
  archiveDisabledReason?: string;
  close: (result?: EditConversationResult) => void;
};

type EditConversationOptions = Pick<EditConversationFormProps, "archiveDisabled" | "archiveDisabledReason">;

const formatRunTime = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const formatRunDuration = (durationMs: number | null): string => {
  if (durationMs === null) return "–";
  if (durationMs >= 1000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${durationMs}ms`;
};

/**
 * User-visible search-index state of one chat: last runs of the enrichment
 * job (summary/keywords/title for search) plus a manual reindex trigger.
 */
function SearchIndexSection(props: { conversationId: string }) {
  const text = useAssistantText();
  const runStatusBadges: Record<AiEnrichmentRun["status"], { label: string; tone: StatusTone }> = {
    ok: { label: text("ok"), tone: "ok" },
    failed: { label: text("failed"), tone: "error" },
    skipped: { label: text("skipped"), tone: "neutral" },
  };
  const [status, setStatus] = createSignal<AiEnrichmentStatus | null>(null);
  const [runs, setRuns] = createSignal<AiEnrichmentRun[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  // Set while a manual reindex is queued/running; cleared when its run shows up.
  const [queuedAt, setQueuedAt] = createSignal<number | null>(null);

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  };
  onCleanup(stopPolling);

  const load = mutation.create<{ status: AiEnrichmentStatus | null; runs: AiEnrichmentRun[] }, void>({
    mutation: async () => assistantApi.getEnrichment(props.conversationId),
    onSuccess: (result) => {
      setStatus(result.status);
      setRuns(result.runs);
      setLoaded(true);
      // The queued reindex is done once a run newer than the click appears.
      const queued = queuedAt();
      if (queued && result.runs.some((run) => Date.parse(run.createdAt) >= queued)) {
        setQueuedAt(null);
        stopPolling();
      }
    },
    onError: (error) => prompts.error(error.message),
  });

  const reindex = mutation.create<void, void>({
    // Toasts render below the native <dialog> top layer, so feedback lives
    // inline: queued state in the status line + polling until the run appears.
    mutation: async () => assistantApi.reindexConversation(props.conversationId),
    onSuccess: () => {
      setQueuedAt(Date.now() - 1_000);
      stopPolling();
      pollTimer = setInterval(() => {
        if (!queuedAt()) return stopPolling();
        // Give up polling after 3 minutes; the table still updates on reopen.
        if (Date.now() - (queuedAt() ?? 0) > 180_000) {
          setQueuedAt(null);
          return stopPolling();
        }
        void load.mutate(undefined);
      }, 5_000);
      void load.mutate(undefined);
    },
    onError: (error) => prompts.error(error.message),
  });

  onMount(() => void load.mutate(undefined));

  const columns: DataTableColumn<AiEnrichmentRun>[] = [
    { id: "when", header: text("When"), value: (run) => formatRunTime(run.createdAt) },
    { id: "status", header: text("Status"), value: "status" },
    { id: "trigger", header: text("Trigger"), value: "trigger" },
    { id: "model", header: text("Model"), value: (run) => run.modelProfileId ?? "–" },
    { id: "duration", header: text("Duration"), value: (run) => formatRunDuration(run.durationMs), cellClass: "tabular-nums" },
    {
      id: "result",
      header: text("Result"),
      value: (run) =>
        run.status === "failed" ? (run.error ?? "failed") : `${run.keywordsCount} keywords${run.titleUpdated ? " · title updated" : ""}`,
    },
  ];

  const statusLine = () => {
    if (queuedAt()) return text("Reindex queued — running in the background…");
    const current = status();
    if (!current) return text("Index state unavailable.");
    if (!current.enrichedAt) return text("Not indexed yet — the next background run will pick this chat up.");
    const indexed = `Last indexed ${formatRunTime(current.enrichedAt)}`;
    return current.dirty ? `${indexed} · changes pending` : `${indexed} · up to date`;
  };

  const busy = () => reindex.loading() || Boolean(queuedAt());

  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-center justify-between gap-2">
        <p class={`min-w-0 truncate text-xs ${queuedAt() ? "text-primary" : "text-dimmed"}`}>
          <Show when={queuedAt()}>
            <i class="ti ti-loader-2 mr-1 inline-block animate-spin" aria-hidden="true" />
          </Show>
          {statusLine()}
        </p>
        <Button
          variant="subtle"
          size="sm"
          class="shrink-0"
          disabled={busy()}
          loading={reindex.loading()}
          loadingLabel={text("Reindexing")}
          onClick={() => reindex.mutate(undefined)}
        >
          <i class="ti ti-refresh" aria-hidden="true" />
          {text(queuedAt() ? "Queued" : "Reindex")}
        </Button>
      </div>

      <Show when={(status()?.keywords.length ?? 0) > 0}>
        <div class="flex flex-wrap gap-1">
          {(status()?.keywords ?? []).map((keyword) => (
            <span class="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{keyword}</span>
          ))}
        </div>
      </Show>

      <Show when={loaded()}>
        <DataTable
          rows={runs()}
          columns={columns}
          getRowId={(run) => run.id}
          density="compact"
          class="max-h-48 overflow-auto rounded-md"
          empty={text("No index runs yet.")}
          renderCell={({ row, col, value, render }) => {
            if (col.id === "status") {
              const badge = runStatusBadges[row.status];
              return <StatusBadge label={badge.label} tone={badge.tone} variant="chip" />;
            }
            return render(value);
          }}
        />
      </Show>
    </div>
  );
}

function EditConversationForm(props: EditConversationFormProps) {
  const text = useAssistantText();
  const copy = useAssistantCopy();
  const [title, setTitle] = createSignal(props.conversation.title);
  const [description, setDescription] = createSignal(props.conversation.description);
  const [pinned, setPinned] = createSignal(Boolean(props.conversation.pinnedAt));
  const initial = {
    title: props.conversation.title,
    description: props.conversation.description,
    pinned: Boolean(props.conversation.pinnedAt),
  };
  const changeCount = () =>
    Number(title() !== initial.title) + Number(description() !== initial.description) + Number(pinned() !== initial.pinned);
  const discard = () => {
    setTitle(initial.title);
    setDescription(initial.description);
    setPinned(initial.pinned);
  };

  const save = mutation.create<AiConversation, void>({
    mutation: async () =>
      assistantApi.updateConversation(props.conversation.id, {
        title: title().trim(),
        description: description().trim(),
        pinned: pinned(),
      }),
    onSuccess: (conversation) => {
      toast.success(text("Chat saved"));
      props.close({ action: "save", conversation });
    },
    onError: (error) => prompts.error(error.message),
  });

  const archive = mutation.create<boolean, void>({
    mutation: async () => {
      if (props.archiveDisabled) return false;
      const confirmed = await prompts.confirm(copy().archiveChat({ title: props.conversation.title }), {
        title: text("Archive chat"),
        icon: "ti ti-archive",
        confirmText: text("Archive"),
        cancelText: text("Cancel"),
      });
      if (!confirmed) return false;

      await assistantApi.archiveConversation(props.conversation.id);
      return true;
    },
    onSuccess: (deleted) => {
      if (!deleted) return;
      toast.success(text("Chat archived"));
      props.close({ action: "archive", conversation: props.conversation });
    },
    onError: (error) => prompts.error(error.message),
  });
  const busy = () => save.loading() || archive.loading();
  const requestClose = async () => {
    if (!busy() && (await confirmDiscardIfDirty(() => changeCount() > 0))) props.close();
  };

  return (
    <div class="dialog-fixed-frame flex min-h-0 flex-col overflow-hidden">
      <SettingsModal title={text("Chat Settings")} onClose={() => void requestClose()} closeLabel={text("Close chat settings")}>
        <SettingsModal.Group title={text("Chat")}>
          <SettingsModal.Tab id="general" title={text("Chat Settings")} icon="ti ti-id" description={text("Name, description, and list placement.")}>
            <SettingsGroup title={text("Identity")} description={text("Choose how this chat appears in navigation and search results.")}>
              <SettingsField
                label={text("Name")}
                description={text("Shown in the chat list and header.")}
                error={() => (!title().trim() ? text("Name is required") : undefined)}
                changed={() => title() !== initial.title}
              >
                <TextInput aria-label={text("Name")} value={title} onValueChange={setTitle} required maxLength={120} disabled={busy()} />
              </SettingsField>
              <SettingsField
                label={text("Description")}
                description={text("Optional context shown with this chat.")}
                error={() => undefined}
                changed={() => description() !== initial.description}
              >
                <TextInput
                  aria-label={text("Description")}
                  value={description}
                  onValueChange={setDescription}
                  multiline
                  lines={3}
                  maxLength={500}
                  placeholder={text("Optional context for this chat...")}
                  disabled={busy()}
                />
              </SettingsField>
              <CheckboxCard
                label={text("Pin this chat")}
                description={text("Keep this chat at the top of your chat list.")}
                icon="ti ti-pin"
                value={pinned}
                onValueChange={setPinned}
                disabled={busy()}
              />
            </SettingsGroup>
            <SettingsModal.Footer>
              <SettingsPanelFooter
                changeCount={changeCount}
                loading={save.loading}
                onDiscard={discard}
                onSave={() => save.mutate(undefined)}
              />
            </SettingsModal.Footer>
          </SettingsModal.Tab>

          <SettingsModal.Tab
            id="search"
            title={text("Search")}
            icon="ti ti-list-search"
            description={text("Review and refresh the generated summary and keywords used to find this chat.")}
          >
            <SettingsGroup title={text("Search index")} description={text("Index status and recent enrichment runs for this chat.")}>
              <SearchIndexSection conversationId={props.conversation.id} />
            </SettingsGroup>
          </SettingsModal.Tab>
        </SettingsModal.Group>

        <SettingsModal.Group title={text("Lifecycle")}>
          <SettingsModal.Tab
            id="archive"
            title={text("Archive")}
            icon="ti ti-archive"
            description={text("Remove this chat from active lists. You can restore it later from All Chats.")}
          >
            <SettingsGroup title={text("Archive chat")} description={props.archiveDisabledReason ?? text("Move this chat out of your active lists.")}>
              <SettingsGroup.Action>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={archive.loading()}
                  loadingLabel={text("Archiving chat")}
                  disabled={busy() || props.archiveDisabled}
                  title={props.archiveDisabledReason}
                  onClick={() => archive.mutate(undefined)}
                >
                  <i class="ti ti-archive" aria-hidden="true" />
                  {text("Archive chat")}
                </Button>
              </SettingsGroup.Action>
            </SettingsGroup>
          </SettingsModal.Tab>
        </SettingsModal.Group>
      </SettingsModal>
    </div>
  );
}

export const openAssistantConversationEditor = (
  conversation: AiConversation,
  options: EditConversationOptions = {},
): Promise<EditConversationResult | undefined> =>
  prompts.dialog<EditConversationResult | undefined>(
    (close) => <EditConversationForm conversation={conversation} close={close} {...options} />,
    {
      surface: "bare",
      header: false,
      size: "large",
    },
  );
