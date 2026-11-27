import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { navigateTo } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import {
  Avatar,
  Bar,
  Button,
  Canvas,
  Cells,
  Chip,
  Empty,
  Failed,
  Inline,
  List,
  Loading,
  Mark,
  Menu,
  type MenuEntry,
  Pane,
  type Person,
  Row,
  Section,
  Tabs,
  Text,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { diffLines } from "diff";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { renderNotebookBook } from "@/lib/book-renderer";
import type { NoteEditDays } from "../../../../service/activity";
import { buildNoteUrl, buildVersionsUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import { readErrorMessage } from "../settings/utils";
import NotebookSidebarBody from "../sidebar/NotebookSidebarBody";
import { useNotebookSidebar } from "../sidebar/notebook-sidebar-state";
import type { NotebookContext } from "../sidebar/types";
import { rememberRestoredVersion, restoreVersionInPlace } from "./restore-notice";
import { VersionContent, VersionDiff } from "./VersionPreview";
import { buildDiffRows, type DiffRow, orderComparison, summarizeDiff } from "./version-history";

type Contributor = { kind: "user" | "service_account"; id: string; displayName: string; avatarHash: string | null };

export type NoteVersion = {
  id: string;
  noteId: string;
  createdBy: string | null;
  createdAt: string;
  contributors?: Contributor[];
};

type PaginationInfo = { page: number; per_page: number; total: number; total_pages: number; has_next: boolean };
type VersionPage = { data: NoteVersion[]; pagination: PaginationInfo };
type VersionData = { contentMd: string | null; yjsSnapshot: string };
type LoadedVersionData = { source: string; data: VersionData };
type ComparisonTarget = { id: string; label: string; createdAt: string | null };
type PreviewMode = "content" | "changes";

export type VersionsWorkspaceProps = {
  ctx: NotebookContext;
  noteId: string;
  noteTitle: string;
  isLocked: boolean;
  currentContentMd: string | null;
  dateConfig: DateContext;
  /** The first page the server loaded; absent when it could not. */
  initialVersions?: NoteVersion[];
  initialTotal?: number;
  /** The version in the address (`?version=`), open from the first picture on. */
  initialVersionId: string | null;
  /** The note's edits per day over 30 days, for the hero; absent when they could not be read. */
  edits?: NoteEditDays;
};

const PER_PAGE = 20;
/** The versions the comparison offers, as v1's version search did: the newest 100, one request. */
const COMPARISON_LIMIT = 100;
/** The live note, as the other side of a comparison. */
const CURRENT_ID = "__current__";
const VERSION_PARAM = "version";

/**
 * A note's version history on v2: the notebook's sidebar, the saved versions as a list, and the open version beside
 * it with its content or its changes against another version (or the live note), and Restore. The open version is in
 * the address, so reload, back and forward show the same; on the phone it is its own page with the way back.
 */
export default function VersionsWorkspace(props: VersionsWorkspaceProps) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const toast = useToast();
  const notebookId = () => props.ctx.notebook.id;
  const listUrl = () => buildVersionsUrl(notebookId(), props.noteId);
  const versionUrl = (id: string) => `${listUrl()}&${VERSION_PARAM}=${encodeURIComponent(id)}`;
  const noteUrl = () => buildNoteUrl(notebookId(), props.noteId);
  const sidebar = useNotebookSidebar({
    ctx: props.ctx,
    graphBack: props.initialVersionId ? versionUrl(props.initialVersionId) : listUrl(),
  });

  const currentTarget = (): ComparisonTarget => ({ id: CURRENT_ID, label: t().currentNote, createdAt: null });
  const [selectedVersionId, setSelectedVersionId] = createSignal<string | null>(props.initialVersionId);
  const [comparisonTarget, setComparisonTarget] = createSignal<ComparisonTarget>(currentTarget());
  const [previewMode, setPreviewMode] = createSignal<PreviewMode>("content");

  const listSource = () => `${notebookId()}:${props.noteId}`;
  const initialTotal = () => props.initialTotal ?? props.initialVersions?.length ?? 0;
  const versionPages = query.createInfinite<string, VersionPage, number>({
    source: listSource,
    ...(props.initialVersions
      ? {
          initial: {
            source: listSource(),
            pages: [
              {
                data: props.initialVersions,
                pagination: {
                  page: 1,
                  per_page: PER_PAGE,
                  total: initialTotal(),
                  total_pages: Math.ceil(initialTotal() / PER_PAGE),
                  has_next: initialTotal() > PER_PAGE,
                },
              },
            ],
          },
        }
      : {}),
    loadPage: async (_source, { cursor, abortSignal }) => {
      const page = cursor ?? 1;
      const response = await apiClient[":id"].notes[":noteId"].versions.$get(
        { param: { id: notebookId(), noteId: props.noteId }, query: { page: String(page), per_page: String(PER_PAGE) } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(t().versionsLoadFailed({ status: response.status }));
      const result = (await response.json()) as VersionPage;
      if (result.pagination.page !== page) throw new Error(t().invalidVersionPage);
      return result;
    },
    getNextCursor: (page) => (page.pagination.has_next ? page.pagination.page + 1 : undefined),
  });
  const versions = createMemo(() => versionPages.pages().flatMap((page) => page.data));
  const pagination = createMemo(() => versionPages.pages().at(-1)?.pagination ?? null);

  const loadVersionData = async (source: string, abortSignal: AbortSignal): Promise<LoadedVersionData> => {
    if (source === CURRENT_ID) return { source, data: { contentMd: props.currentContentMd, yjsSnapshot: "" } };
    const response = await apiClient[":id"].notes[":noteId"].versions[":versionId"].content.$get(
      { param: { id: notebookId(), noteId: props.noteId, versionId: source } },
      { init: { signal: abortSignal } },
    );
    if (!response.ok) throw new Error(t().versionLoadFailed({ status: response.status }));
    return { source, data: (await response.json()) as VersionData };
  };
  const selectedVersion = query.create<string | null, LoadedVersionData>({
    source: selectedVersionId,
    enabled: () => selectedVersionId() !== null,
    load: (source, { abortSignal }) => loadVersionData(source!, abortSignal),
  });
  const comparisonVersion = query.create<string, LoadedVersionData>({
    source: () => comparisonTarget().id,
    enabled: () => previewMode() === "changes",
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
  const contentLoading = () => selectedVersion.loading() || selectedVersion.refreshing();
  const changesLoading = () => contentLoading() || comparisonVersion.loading() || comparisonVersion.refreshing();
  const changesFailed = () => !!selectedVersion.error() || !!comparisonVersion.error();

  // ── The open version, in the address ──

  const open = (versionId: string | null) => {
    if (versionId && comparisonTarget().id === versionId) setComparisonTarget(currentTarget());
    setSelectedVersionId(versionId);
  };
  onMount(() => {
    // Back and forward move between open versions; the address says which.
    const onPop = () => open(new URLSearchParams(window.location.search).get(VERSION_PARAM));
    window.addEventListener("popstate", onPop);
    onCleanup(() => window.removeEventListener("popstate", onPop));
  });

  const formatDate = (iso: string) => dates.formatDateTime(iso, props.dateConfig);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const editsTotal = () => (props.edits?.perDay ?? []).reduce((sum, count) => sum + count, 0);
  const selectedVersionMeta = () => versions().find((version) => version.id === selectedVersionId()) ?? null;

  // ── Comparison ──

  /** Versions in time order, with a comparison target from further back that the list has not loaded. */
  const orderVersions = () => {
    const target = comparisonTarget();
    return target.createdAt && !versions().some((version) => version.id === target.id)
      ? [...versions(), { id: target.id, createdAt: target.createdAt }]
      : versions();
  };
  const comparison = createMemo(() => {
    const selectedId = selectedVersionId();
    if (!selectedId) return null;
    const target = comparisonTarget();
    const { fromId, toId } = orderComparison(selectedId, target.id, orderVersions(), CURRENT_ID);
    const labelFor = (id: string) => {
      if (id === CURRENT_ID) return t().currentNote;
      if (id === target.id) return target.label;
      const version = versions().find((entry) => entry.id === id);
      return version ? formatDate(version.createdAt) : t().unknownVersion;
    };
    return { from: labelFor(fromId), fromId, to: labelFor(toId), toId };
  });
  const diffRows = createMemo<DiffRow[]>(() => {
    const selectedData = selectedVersionData();
    const comparisonData = comparisonVersionData();
    const order = comparison();
    if (!order || !selectedData || !comparisonData) return [];
    const fromData = order.fromId === selectedVersionId() ? selectedData : comparisonData;
    const toData = order.fromId === selectedVersionId() ? comparisonData : selectedData;
    return buildDiffRows(diffLines(fromData.contentMd ?? "", toData.contentMd ?? ""));
  });
  const diffSummary = createMemo(() => summarizeDiff(diffRows()));
  // The other side of a comparison: the live note or any loaded version except the open one.
  // The other side reaches the newest 100 versions, as v1 did, whatever the list has paged in; they load once, when
  // the changes are first shown.
  const comparisonVersions = query.create<string, NoteVersion[]>({
    source: listSource,
    enabled: () => previewMode() === "changes",
    load: async (_source, { abortSignal }) => {
      const response = await apiClient[":id"].notes[":noteId"].versions.$get(
        { param: { id: notebookId(), noteId: props.noteId }, query: { page: "1", per_page: String(COMPARISON_LIMIT) } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(t().savedVersionsLoadFailed);
      return ((await response.json()) as VersionPage).data;
    },
  });
  const comparisonCandidates = createMemo(() => {
    const byId = new Map<string, NoteVersion>();
    for (const version of [...(comparisonVersions.data() ?? []), ...versions()]) byId.set(version.id, version);
    return [...byId.values()]
      .filter((version) => version.id !== selectedVersionId())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
  // k2b-ui gap: Menu has no search, so the 100 versions are a plain list; lane N's `Menu search` (#4237) filters them.
  const comparisonChoices = (): MenuEntry[] => [
    {
      title: t().compareWith,
      choice: comparisonTarget().id,
      onChoose: (id) => {
        const version = comparisonCandidates().find((entry) => entry.id === id);
        setComparisonTarget(version ? { id, label: formatDate(version.createdAt), createdAt: version.createdAt } : currentTarget());
      },
      items: [
        { label: t().currentNote, icon: "file-text", value: CURRENT_ID, meta: t().liveContent },
        ...comparisonCandidates().map((version) => ({ label: formatDate(version.createdAt), icon: "history", value: version.id })),
      ],
    },
    // a failed load keeps the live note and the loaded versions, and says so with its retry
    ...(comparisonVersions.error()
      ? [
          "separator" as const,
          { label: t().savedVersionsLoadFailed, icon: "alert-circle", disabled: true },
          { label: t().retry, icon: "refresh", onClick: () => void comparisonVersions.refresh() },
        ]
      : []),
  ];

  // A version reads as Book does: note, heading and attachment links are references, and a query shows its definition.
  const selectedContentHtml = createMemo(
    () =>
      renderNotebookBook({
        markdown: selectedVersionData()?.contentMd ?? "",
        notebookId: notebookId(),
        noteId: props.noteId,
        locale: locale(),
        querySource: true,
      }).html,
  );

  // ── Restore ──

  const restoreMut = mutations.create<{ previousVersionId: string | null }, string>({
    mutation: (versionId) =>
      restoreVersionInPlace({ notebookId: notebookId(), noteId: props.noteId, versionId, failed: t().restoreFailed }),
    onSuccess: ({ previousVersionId }) => {
      rememberRestoredVersion(props.noteId, previousVersionId);
      // Write mode shows the restore live and lets Undo arrive the same way; Book and Read-only would show neither.
      navigateTo(buildNoteUrl(notebookId(), props.noteId, "write"));
    },
    onError: (error) => void toast(error.message, { status: "bad" }),
  });
  const restoreAsCopyMut = mutations.create<{ id: string }, string>({
    mutation: async (versionId) => {
      const response = await apiClient[":id"].notes[":noteId"].versions[":versionId"].copy.$post({
        param: { id: notebookId(), noteId: props.noteId, versionId },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, t().restoreFailed));
      return response.json();
    },
    onSuccess: (copy) => navigateTo(buildNoteUrl(notebookId(), copy.id)),
    onError: (error) => void toast(error.message, { status: "bad" }),
  });
  const working = () => restoreMut.loading() || restoreAsCopyMut.loading();
  const restore = () => {
    const versionId = selectedVersionId();
    if (versionId && !working()) restoreMut.mutate(versionId);
  };
  const restoreAsCopy = () => {
    const versionId = selectedVersionId();
    if (versionId && !working()) restoreAsCopyMut.mutate(versionId);
  };

  const contributor = (entry: Contributor): Person => ({
    name: entry.displayName,
    image:
      entry.kind === "user" && entry.avatarHash
        ? `/api/accounts/users/${encodeURIComponent(entry.id)}/avatar?rev=${encodeURIComponent(entry.avatarHash)}`
        : undefined,
  });

  /** One row per saved version: its date, how long ago, and who changed the note in it. */
  const versionRows = () => (
    <For each={versions()}>
      {(version) => (
        <Row
          icon="history"
          lines={[formatDate(version.createdAt), dates.formatDateTimeRelative(version.createdAt, props.dateConfig)]}
          current={selectedVersionId() === version.id}
          href={versionUrl(version.id)}
          onNavigate={({ push }) => {
            open(version.id);
            push();
          }}
          // the list's one data column: who changed the note in this version
          marks={
            <Show when={(version.contributors?.length ?? 0) > 0}>
              <Avatar.Stack people={version.contributors!.map(contributor)} />
            </Show>
          }
        />
      )}
    </For>
  );

  return (
    <>
      {/* k2b-ui gap: Nav tree – the phone menu keeps the v1 navigation with the whole tree and its note menus. */}
      <WorkspaceNavigationProvider navigation={sidebar.mobileNavigation} label={props.ctx.notebook.name} />
      <Workspace
        sidebar={<NotebookSidebarBody sidebar={sidebar} />}
        detail={480}
        detailEmpty={{ icon: "file-search", text: t().selectVersionDescription }}
        head={
          <Bar
            start={
              <>
                <Text weight="strong">{t().versionHistory}</Text>
                <Text muted>{props.noteTitle || t().untitled}</Text>
              </>
            }
            end={<Button icon="x" label={t().backToEditor} href={noteUrl()} keep />}
          />
        }
      >
        <Pane.Split>
          <Pane label={t().savedVersions} width={{ min: 260, default: 320 }} scrollKey="notebook-versions">
            {/* k2b-ui gap: hero band (the one figure in type 30 and the app colour beside its real trend, exceptions
                below) – lane DP. Until it lands, the figure and its 30 days stand in the nearest part, a cell with its
                spark, beside the number of saved versions. */}
            <Show when={props.edits}>
              {(edits) => (
                <Cells>
                  <Cells.Cell
                    icon="pencil"
                    color="var(--k2-app)"
                    label={t().editsThirtyDays}
                    value={number(editsTotal())}
                    meta={edits().people > 0 ? t().editsPeople({ count: edits().people }) : undefined}
                    trend={{
                      values: edits().perDay,
                      label: t().editsTrend({ total: number(editsTotal()), today: number(edits().perDay.at(-1) ?? 0) }),
                    }}
                  />
                  <Cells.Cell icon="history" label={t().savedVersions} value={number(pagination()?.total ?? initialTotal())} />
                </Cells>
              )}
            </Show>
            <Show
              when={versions().length > 0}
              fallback={
                <Show
                  when={versionPages.error()}
                  fallback={
                    <Show when={versionPages.loading()} fallback={<Empty icon="history" text={t().noVersions} />}>
                      <Loading rows={6} lines={2} />
                    </Show>
                  }
                >
                  <Failed text={t().versionsCouldNotLoad} onRetry={() => void versionPages.refresh()} />
                </Show>
              }
            >
              {/* the hero above names and counts the versions once; without it the section head does */}
              <Show
                when={props.edits}
                fallback={
                  <Section title={t().savedVersions} count={pagination()?.total}>
                    {versionRows()}
                  </Section>
                }
              >
                <List label={t().savedVersions}>{versionRows()}</List>
              </Show>
              {/* An older page that failed keeps the loaded versions and says so after them, with the retry. */}
              <Show when={versionPages.error()}>
                <Failed text={versionPages.error()!.message} onRetry={() => void versionPages.loadMore()} />
              </Show>
              <Show when={pagination()?.has_next && !versionPages.error()}>
                <Bar
                  end={
                    <Button busy={versionPages.loadingMore()} onClick={() => void versionPages.loadMore()}>
                      {t().loadMore}
                    </Button>
                  }
                />
              </Show>
            </Show>
          </Pane>
          <Show when={selectedVersionId()}>
            <Pane
              detail
              label={t().versionPreview}
              back={{
                label: t().savedVersions,
                href: listUrl(),
                onNavigate: ({ push }) => {
                  open(null);
                  push();
                },
              }}
              head={
                <Bar
                  // k2b-ui gap: tinted object head (40 px sign, name 18, meta line) – lane DP; the version's mark and
                  // date stand in the head bar until it lands.
                  start={
                    <Inline>
                      <Mark icon="history" color="var(--k2-app)" />
                      <Text type="lead">{selectedVersionMeta() ? formatDate(selectedVersionMeta()!.createdAt) : t().versionPreview}</Text>
                    </Inline>
                  }
                  end={
                    <Show
                      when={!props.isLocked}
                      fallback={
                        <Button
                          icon="copy"
                          busy={restoreAsCopyMut.loading()}
                          disabled={working()}
                          title={t().restoreAsCopyHint}
                          keep
                          onClick={restoreAsCopy}
                        >
                          {t().restoreAsCopy}
                        </Button>
                      }
                    >
                      <Button
                        variant="primary"
                        icon="history"
                        busy={restoreMut.loading()}
                        disabled={working()}
                        title={t().restoreVersionHint}
                        keep
                        onClick={restore}
                      >
                        {t().restoreVersion}
                      </Button>
                      <Menu
                        label={t().moreRestoreOptions}
                        disabled={working()}
                        items={[{ label: t().restoreAsCopy, icon: "copy", meta: t().restoreAsCopyHint, onClick: restoreAsCopy }]}
                      />
                    </Show>
                  }
                />
              }
              status={
                <Bar
                  start={
                    <Tabs
                      label={t().versionPreview}
                      items={[
                        {
                          label: t().content,
                          icon: "file-text",
                          current: previewMode() === "content",
                          onClick: () => setPreviewMode("content"),
                        },
                        {
                          label: t().changes,
                          icon: "git-compare",
                          current: previewMode() === "changes",
                          onClick: () => setPreviewMode("changes"),
                        },
                      ]}
                    />
                  }
                  end={
                    <>
                      <Show when={props.isLocked}>
                        <Chip icon="lock">{t().locked}</Chip>
                      </Show>
                      <Show when={previewMode() === "changes"}>
                        <Menu label={t().changeComparison} items={comparisonChoices()}>
                          {t().change}
                        </Menu>
                      </Show>
                    </>
                  }
                />
              }
            >
              <Show
                when={previewMode() === "changes"}
                fallback={
                  <Show when={!contentLoading()} fallback={<Loading rows={8} lines={1} />}>
                    <Show
                      when={selectedVersionData()}
                      fallback={<Failed text={t().versionRequestFailed} onRetry={() => void selectedVersion.refresh()} />}
                    >
                      {(data) => (
                        <Show when={data().contentMd?.trim()} fallback={<Empty icon="file-off" text={t().emptyVersionDescription} />}>
                          <Canvas label={selectedVersionMeta() ? formatDate(selectedVersionMeta()!.createdAt) : t().versionPreview}>
                            <VersionContent html={selectedContentHtml()} />
                          </Canvas>
                        </Show>
                      )}
                    </Show>
                  </Show>
                }
              >
                {/* what is compared with what, standing before the diff while it loads, so nothing moves */}
                <Show when={comparison()}>
                  {(order) => (
                    <Bar
                      start={
                        <>
                          <Text type="meta">{t().comparing}</Text>
                          <Text weight="medium">{order().from}</Text>
                          <Text muted>→</Text>
                          <Text weight="medium">{order().to}</Text>
                        </>
                      }
                      end={
                        <Show when={!changesLoading() && diffSummary().hasChanges}>
                          <Text type="meta">
                            +{diffSummary().added} −{diffSummary().removed}
                          </Text>
                        </Show>
                      }
                    />
                  )}
                </Show>
                <Show when={!changesLoading()} fallback={<Loading rows={8} lines={1} />}>
                  <Show
                    when={!changesFailed()}
                    fallback={
                      <Failed
                        text={t().comparisonRequestFailed}
                        onRetry={() => void Promise.allSettled([selectedVersion.refresh(), comparisonVersion.refresh()])}
                      />
                    }
                  >
                    <Show when={diffSummary().hasChanges} fallback={<Empty icon="check" text={t().noDifferencesDescription} />}>
                      <Canvas label={t().changes}>
                        <VersionDiff rows={diffRows()} />
                      </Canvas>
                    </Show>
                  </Show>
                </Show>
              </Show>
            </Pane>
          </Show>
        </Pane.Split>
      </Workspace>
    </>
  );
}
