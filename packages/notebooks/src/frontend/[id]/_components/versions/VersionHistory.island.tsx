import { navigateTo } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { Avatar, Button, IconButtonLink, MarkdownView, openSpotlightSearch, Placeholder, prompts, SegmentedControl } from "@k2b/ui";
import { markdown } from "@valentinkolb/cloud/shared";
import { diffLines } from "diff";
import { createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { buildNoteUrl } from "../../../params";
import { buildDiffRows, type DiffRow, orderComparison, summarizeDiff } from "./version-history";

type NoteVersion = {
  id: string;
  noteId: string;
  createdBy: string | null;
  createdAt: string;
  contributors?: Array<{
    kind: "user" | "service_account";
    id: string;
    displayName: string;
    avatarHash: string | null;
  }>;
};

type PaginationInfo = {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
  has_next: boolean;
};

type VersionData = {
  contentMd: string | null;
  yjsSnapshot: string;
};

type VersionPage = {
  data: NoteVersion[];
  pagination: PaginationInfo;
};

type LoadedVersionData = {
  source: string;
  data: VersionData;
};

type Props = {
  notebookId: string;
  noteId: string;
  noteTitle: string;
  isLocked?: boolean;
  currentContentMd: string | null;
  dateConfig: DateContext;
  initialVersions?: NoteVersion[];
  initialTotal?: number;
};

type PreviewMode = "content" | "changes";

type ComparisonTarget = {
  id: string;
  label: string;
  createdAt: string | null;
};

const PER_PAGE = 20;

/** Pseudo-ID for "Current version" */
const CURRENT_ID = "__current__";
const CURRENT_TARGET: ComparisonTarget = {
  id: CURRENT_ID,
  label: "Current note",
  createdAt: null,
};

export default function VersionHistory(props: Props) {
  const hasInitialVersions = props.initialVersions !== undefined;
  const [selectedVersionId, setSelectedVersionId] = createSignal<string | null>(null);
  const [comparisonTarget, setComparisonTarget] = createSignal<ComparisonTarget>(CURRENT_TARGET);
  const [previewMode, setPreviewMode] = createSignal<PreviewMode>("content");
  const backUrl = buildNoteUrl(props.notebookId, props.noteId);
  const listSource = `${props.notebookId}:${props.noteId}`;
  const initialPage: VersionPage | undefined = hasInitialVersions
    ? {
        data: props.initialVersions!,
        pagination: {
          page: 1,
          per_page: PER_PAGE,
          total: props.initialTotal ?? props.initialVersions!.length,
          total_pages: Math.ceil((props.initialTotal ?? props.initialVersions!.length) / PER_PAGE),
          has_next: (props.initialTotal ?? props.initialVersions!.length) > PER_PAGE,
        },
      }
    : undefined;
  const versionPages = query.createInfinite<string, VersionPage, number>({
    source: () => listSource,
    ...(initialPage ? { initial: { source: listSource, pages: [initialPage] } } : {}),
    loadPage: async (_source, { cursor, abortSignal }) => {
      const page = cursor ?? 1;
      const response = await apiClient[":id"].notes[":noteId"].versions.$get(
        {
          param: { id: props.notebookId, noteId: props.noteId },
          query: { page: String(page), per_page: String(PER_PAGE) },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(`Failed to load versions (${response.status})`);
      const result = (await response.json()) as VersionPage;
      if (result.pagination.page !== page) throw new Error("The server returned an invalid version page");
      return result;
    },
    getNextCursor: (page) => (page.pagination.has_next ? page.pagination.page + 1 : undefined),
  });
  const versions = createMemo(() => versionPages.pages().flatMap((page) => page.data));
  const pagination = createMemo(() => versionPages.pages().at(-1)?.pagination ?? null);

  const loadVersionData = async (source: string, abortSignal: AbortSignal): Promise<LoadedVersionData> => {
    if (source === CURRENT_ID) {
      return { source, data: { contentMd: props.currentContentMd, yjsSnapshot: "" } };
    }
    const response = await apiClient[":id"].notes[":noteId"].versions[":versionId"].content.$get(
      { param: { id: props.notebookId, noteId: props.noteId, versionId: source } },
      { init: { signal: abortSignal } },
    );
    if (!response.ok) throw new Error(`Failed to load version (${response.status})`);
    return { source, data: (await response.json()) as VersionData };
  };
  const selectedVersion = query.create<string | null, LoadedVersionData>({
    source: selectedVersionId,
    enabled: () => selectedVersionId() !== null,
    load: (source, { abortSignal }) => loadVersionData(source!, abortSignal),
  });
  const comparisonVersion = query.create<string, LoadedVersionData>({
    source: () => comparisonTarget().id,
    load: (source, { abortSignal }) => loadVersionData(source, abortSignal),
  });
  const selectedVersionData = createMemo(() => {
    const loaded = selectedVersion.data();
    return loaded?.source === selectedVersionId() ? loaded.data : null;
  });
  const comparisonVersionData = createMemo(() => {
    const loaded = comparisonVersion.data();
    return loaded?.source === comparisonTarget().id ? loaded.data : null;
  });
  const previewLoading = () =>
    selectedVersion.loading() || selectedVersion.refreshing() || comparisonVersion.loading() || comparisonVersion.refreshing();
  const previewError = () => !!selectedVersion.error() || !!comparisonVersion.error();

  // ── Selection logic ──

  const selectVersion = (versionId: string) => {
    const target = comparisonTarget().id === versionId ? CURRENT_TARGET : comparisonTarget();
    setSelectedVersionId(versionId);
    setComparisonTarget(target);
  };

  const changeComparison = (target: ComparisonTarget) => {
    const selectedId = selectedVersionId();
    if (!selectedId || target.id === selectedId) return;
    setComparisonTarget(target);
    setPreviewMode("changes");
  };

  const openComparisonPicker = async () => {
    let data: { data: NoteVersion[] };
    try {
      const res = await apiClient[":id"].notes[":noteId"].versions.$get({
        param: { id: props.notebookId, noteId: props.noteId },
        query: { page: "1", per_page: "100" },
      });
      if (!res.ok) throw new Error();
      data = (await res.json()) as { data: NoteVersion[] };
    } catch {
      await prompts.error("Failed to load saved versions.");
      return;
    }

    const targets: ComparisonTarget[] = [
      CURRENT_TARGET,
      ...data.data
        .filter((version) => version.id !== selectedVersionId())
        .map((version) => ({ id: version.id, label: formatDate(version.createdAt), createdAt: version.createdAt })),
    ];
    const selected = await openSpotlightSearch<ComparisonTarget>({
      title: "Compare with",
      icon: "ti ti-git-compare",
      placeholder: "Search saved versions...",
      noResultsText: "No matching versions.",
      resolve: ({ query }) => {
        const needle = query.trim().toLowerCase();
        return targets
          .filter((target) => needle.length === 0 || target.label.toLowerCase().includes(needle))
          .map((target) => ({
            value: target,
            label: target.label,
            desc: target.id === CURRENT_ID ? "Live content" : "Saved version",
            icon: target.id === CURRENT_ID ? "ti ti-file-text" : "ti ti-history",
          }));
      },
    });
    if (selected?.value) changeComparison(selected.value);
  };

  // ── Restore ──

  const getRestoreSnapshot = (): string | null => {
    const selectedId = selectedVersionId();
    if (!selectedId) return null;
    return selectedVersionData()?.yjsSnapshot ?? null;
  };

  const restoreAsNewMut = mutations.create<{ id: string }, string>({
    mutation: async (snapshot) => {
      const createRes = await apiClient[":id"].notes.$post({
        param: { id: props.notebookId },
        json: {},
      });
      if (!createRes.ok) throw new Error("Failed to create note");
      const newNote = (await createRes.json()) as { id: string };

      const restoreRes = await apiClient[":id"].notes[":noteId"].restore.$post({
        param: { id: props.notebookId, noteId: newNote.id },
        json: { yjsSnapshot: snapshot },
      });
      if (!restoreRes.ok) {
        await apiClient[":id"].notes[":noteId"].$delete({
          param: { id: props.notebookId, noteId: newNote.id },
        });
        throw new Error("Failed to restore content");
      }
      return newNote;
    },
    onSuccess: (data) => {
      navigateTo(buildNoteUrl(props.notebookId, data.id));
    },
    onError: (err) => prompts.error(err.message),
  });

  const handleRestoreAsNew = async () => {
    const snapshot = getRestoreSnapshot();
    if (!snapshot) return;
    restoreAsNewMut.mutate(snapshot);
  };

  // ── Helpers ──

  const formatDate = (iso: string) => dates.formatDateTime(iso, props.dateConfig);

  const isWorking = () => restoreAsNewMut.loading();

  const comparisonLabel = createMemo((): { from: string; fromId: string; to: string; toId: string } | null => {
    const selectedId = selectedVersionId();
    if (!selectedId) return null;
    const target = comparisonTarget();
    const orderVersions =
      target.createdAt && !versions().some((version) => version.id === target.id)
        ? [...versions(), { id: target.id, createdAt: target.createdAt }]
        : versions();
    const { fromId, toId } = orderComparison(selectedId, target.id, orderVersions, CURRENT_ID);
    const labelFor = (id: string) => {
      if (id === CURRENT_ID) return "Current note";
      if (id === target.id) return target.label;
      const version = versions().find((entry) => entry.id === id);
      return version ? formatDate(version.createdAt) : "Unknown version";
    };
    return { from: labelFor(fromId), fromId, to: labelFor(toId), toId };
  });

  const diffRows = createMemo<DiffRow[]>(() => {
    const selectedId = selectedVersionId();
    const selectedData = selectedVersionData();
    const comparisonData = comparisonVersionData();
    if (!selectedId || !selectedData || !comparisonData) return [];
    const target = comparisonTarget();
    const orderVersions =
      target.createdAt && !versions().some((version) => version.id === target.id)
        ? [...versions(), { id: target.id, createdAt: target.createdAt }]
        : versions();
    const { fromId } = orderComparison(selectedId, target.id, orderVersions, CURRENT_ID);
    const fromData = fromId === selectedId ? selectedData : comparisonData;
    const toData = fromId === selectedId ? comparisonData : selectedData;
    return buildDiffRows(diffLines(fromData.contentMd ?? "", toData.contentMd ?? ""));
  });
  const diffSummary = createMemo(() => summarizeDiff(diffRows()));

  const selectedContentHtml = createMemo(() => markdown.renderSync(selectedVersionData()?.contentMd ?? ""));

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-2">
      {/* Header */}
      <div class="flex shrink-0 flex-wrap items-center justify-between gap-2 px-2 pt-2">
        <div class="flex items-center gap-2">
          <IconButtonLink href={backUrl} size="sm" class="text-dimmed" label="Back to editor">
            <i class="ti ti-arrow-left" />
          </IconButtonLink>
          <div>
            <h2 class="text-sm font-semibold">Version History</h2>
            <p class="text-xs text-dimmed">{props.noteTitle}</p>
          </div>
        </div>

        <Show when={selectedVersionId()}>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <SegmentedControl
              ariaLabel="Version preview"
              size="sm"
              value={previewMode}
              onValueChange={setPreviewMode}
              options={[
                { value: "content", label: "Content", icon: "ti ti-file-text" },
                { value: "changes", label: "Changes", icon: "ti ti-git-compare" },
              ]}
            />
            <Show when={props.isLocked}>
              <span class="text-xs text-dimmed flex items-center gap-1">
                <i class="ti ti-lock text-xs" />
                Locked
              </span>
            </Show>
            <Button
              size="sm"
              onClick={handleRestoreAsNew}
              disabled={isWorking() || previewLoading() || !getRestoreSnapshot()}
              loading={restoreAsNewMut.loading()}
              loadingLabel="Creating note"
              title="Creates a new note. The current note stays unchanged."
            >
              {restoreAsNewMut.loading() ? (
                <i class="ti ti-loader-2 animate-spin" />
              ) : (
                <>
                  <i class="ti ti-file-plus mr-1" />
                  Create note from version
                </>
              )}
            </Button>
          </div>
        </Show>
      </div>

      {/* Loading */}
      <Show when={versionPages.loading()}>
        <div class="flex-1 flex items-center justify-center">
          <i class="ti ti-loader-2 animate-spin text-dimmed" />
        </div>
      </Show>

      {/* Empty */}
      <Show when={!versionPages.loading() && versions().length === 0}>
        <div class="flex-1 flex items-center justify-center">
          <Show
            when={!versionPages.error()}
            fallback={
              <Placeholder icon="ti ti-alert-circle" title="Versions could not be loaded" description="Reload this page to try again." />
            }
          >
            <Placeholder icon="ti ti-history" description={<>No versions yet</>} />
          </Show>
        </div>
      </Show>

      {/* Two-column body */}
      <Show when={!versionPages.loading() && versions().length > 0}>
        <div class="flex-1 min-h-0 app-cols">
          {/* Left: version list */}
          <div class="notebooks-version-history-list overflow-y-auto scrollbar">
            <div class="flex flex-col gap-0.5 p-2">
              <p class="px-2.5 pb-1 text-[10px] font-semibold uppercase text-dimmed">Saved versions</p>
              <For each={versions()}>
                {(version) => (
                  <Button
                    variant={selectedVersionId() === version.id ? "subtle" : "ghost"}
                    size="sm"
                    onClick={() => selectVersion(version.id)}
                    class="w-full justify-start text-left"
                    aria-pressed={selectedVersionId() === version.id}
                  >
                    <i class="ti ti-history text-[11px] text-dimmed" />
                    <span>{formatDate(version.createdAt)}</span>
                    <Show when={(version.contributors?.length ?? 0) > 0}>
                      <span
                        class="ml-auto flex items-center -space-x-1"
                        title={`Contributors: ${version.contributors!.map((contributor) => contributor.displayName).join(", ")}`}
                        aria-label={`Contributors: ${version.contributors!.map((contributor) => contributor.displayName).join(", ")}`}
                      >
                        <For each={version.contributors!.slice(0, 3)}>
                          {(contributor) => <Avatar name={contributor.displayName} size="xs" />}
                        </For>
                        <Show when={version.contributors!.length > 3}>
                          <span class="pl-1 text-[10px] text-dimmed">+{version.contributors!.length - 3}</span>
                        </Show>
                      </span>
                    </Show>
                  </Button>
                )}
              </For>

              {/* Load more */}
              <Show when={pagination()?.has_next}>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => void versionPages.loadMore()}
                  disabled={versionPages.loadingMore()}
                  loading={versionPages.loadingMore()}
                  loadingLabel="Loading more"
                  class="w-full"
                >
                  Load more
                </Button>
              </Show>

              <Show when={versionPages.error()}>
                <div class="flex flex-col items-center gap-1 px-2 py-1 text-center text-[11px] text-red-600 dark:text-red-400">
                  <span>{versionPages.error()!.message}</span>
                  <Button variant="ghost" size="xs" onClick={() => void versionPages.refresh()} loading={versionPages.refreshing()}>
                    Retry
                  </Button>
                </div>
              </Show>

              <Show when={pagination()}>
                <p class="text-[10px] text-dimmed text-center py-1">
                  {versions().length} / {pagination()!.total}
                </p>
              </Show>
            </div>
          </div>

          {/* Right: saved content and optional comparison */}
          <div class="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
            <Show when={selectedVersionId() && previewMode() === "changes" && comparisonLabel()}>
              <div class="flex shrink-0 flex-wrap items-center gap-3 px-3 pb-2">
                <div class="min-w-0 flex-1">
                  <p class="text-[10px] font-semibold uppercase text-dimmed">Comparing</p>
                  <p class="mt-1 flex min-w-0 items-center gap-1.5 text-xs">
                    <span class="flex min-w-0 items-center gap-1">
                      <span class="truncate font-medium text-primary">{comparisonLabel()!.from}</span>
                      <Show when={comparisonLabel()!.fromId === comparisonTarget().id}>
                        <Button
                          variant="ghost"
                          size="xs"
                          class="shrink-0"
                          onClick={openComparisonPicker}
                          aria-label="Change comparison version"
                        >
                          Change
                        </Button>
                      </Show>
                    </span>
                    <i class="ti ti-arrow-right shrink-0 text-dimmed" />
                    <span class="flex min-w-0 items-center gap-1">
                      <span class="truncate font-medium text-primary">{comparisonLabel()!.to}</span>
                      <Show when={comparisonLabel()!.toId === comparisonTarget().id}>
                        <Button
                          variant="ghost"
                          size="xs"
                          class="shrink-0"
                          onClick={openComparisonPicker}
                          aria-label="Change comparison version"
                        >
                          Change
                        </Button>
                      </Show>
                    </span>
                  </p>
                </div>
                <Show when={!previewLoading() && diffSummary().hasChanges}>
                  <div class="flex items-center gap-2 font-mono text-[11px] tabular-nums">
                    <span class="text-green-700 dark:text-green-300">+{diffSummary().added}</span>
                    <span class="text-red-700 dark:text-red-300">-{diffSummary().removed}</span>
                  </div>
                </Show>
              </div>
            </Show>

            <div class="flex-1 min-h-0 overflow-auto scrollbar">
              <Show when={!selectedVersionId()}>
                <div class="flex h-full items-center justify-center">
                  <Placeholder
                    icon="ti ti-file-search"
                    title="Select a saved version"
                    description="Its saved content opens here. You can then inspect its changes against the current note."
                  />
                </div>
              </Show>

              <Show when={selectedVersionId()}>
                <Show when={previewLoading()}>
                  <div class="flex h-full items-center justify-center">
                    <i class="ti ti-loader-2 animate-spin text-dimmed" />
                  </div>
                </Show>

                <Show when={!previewLoading() && previewMode() === "content" && !selectedVersionData()}>
                  <div class="flex h-full items-center justify-center">
                    <Placeholder
                      icon="ti ti-alert-circle"
                      title="Version could not be loaded"
                      description="The saved content request failed."
                      action={
                        <Button type="button" variant="secondary" size="sm" onClick={() => void selectedVersion.refresh()}>
                          Retry
                        </Button>
                      }
                    />
                  </div>
                </Show>

                <Show when={!previewLoading() && previewMode() === "content" && selectedVersionData()}>
                  <Show
                    when={selectedVersionData()?.contentMd?.trim()}
                    fallback={
                      <div class="flex h-full items-center justify-center">
                        <Placeholder
                          icon="ti ti-file-off"
                          title="Empty version"
                          description="This saved version has no Markdown content."
                        />
                      </div>
                    }
                  >
                    <div class="mx-auto w-full max-w-4xl p-4">
                      <MarkdownView trustedHtml={selectedContentHtml()} />
                    </div>
                  </Show>
                </Show>

                <Show when={!previewLoading() && previewMode() === "changes" && previewError()}>
                  <div class="flex h-full items-center justify-center">
                    <Placeholder
                      icon="ti ti-alert-circle"
                      title="Comparison could not be loaded"
                      description="One or both version requests failed."
                      action={
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => void Promise.allSettled([selectedVersion.refresh(), comparisonVersion.refresh()])}
                        >
                          Retry
                        </Button>
                      }
                    />
                  </div>
                </Show>

                <Show when={!previewLoading() && previewMode() === "changes" && !previewError() && diffSummary().hasChanges}>
                  <div class="min-w-max font-mono text-xs leading-5">
                    <For each={diffRows()}>
                      {(row) => (
                        <div
                          class={`grid grid-cols-[2.5rem_2.5rem_1.5rem_minmax(20rem,1fr)] ${
                            row.kind === "added"
                              ? "bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-300"
                              : row.kind === "removed"
                                ? "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300"
                                : "text-secondary"
                          }`}
                        >
                          <span class="select-none px-1 text-right text-dimmed tabular-nums">{row.oldLine ?? ""}</span>
                          <span class="select-none px-1 text-right text-dimmed tabular-nums">{row.newLine ?? ""}</span>
                          <span class="select-none text-center text-dimmed">
                            {row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "}
                          </span>
                          <span class="whitespace-pre-wrap break-words pr-3">{row.value || " "}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={!previewLoading() && previewMode() === "changes" && !previewError() && !diffSummary().hasChanges}>
                  <div class="flex h-full items-center justify-center">
                    <Placeholder icon="ti ti-check" title="No differences" description="Both versions contain the same Markdown content." />
                  </div>
                </Show>
              </Show>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
