import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, NoticeCard, PanelDialog, Placeholder, prompts, toast, useLocale } from "@k2b/ui";
import { createSignal, For, onMount, Show } from "solid-js";
import type { z } from "zod";
import { apiClient } from "../../../api/client";
import {
  PublicGridsWorkflowRevisionListSchema,
  PublicGridsWorkflowRevisionSchema,
  PublicGridsWorkflowSchema,
} from "../../../api/workflow-public-contracts";
import { errorMessage } from "../utils/api-helpers";
import type { PublicWorkflow } from "../workspace/workspace-public-state-model";
import { workflowMessages } from "./messages";
import { formatWorkflowRunDate } from "./workflow-display";

type PublicWorkflowRevision = z.infer<typeof PublicGridsWorkflowRevisionSchema>;
type RevisionPage = z.infer<typeof PublicGridsWorkflowRevisionListSchema>;

const revisionApi = apiClient.workflows as unknown as {
  [":workflowId"]: {
    revisions: {
      $get: (
        input: { param: { workflowId: string }; query: { limit: string; beforeRevision?: string } },
        options?: { init?: RequestInit },
      ) => Promise<Response>;
      [":revision"]: {
        $get: (input: { param: { workflowId: string; revision: string } }, options?: { init?: RequestInit }) => Promise<Response>;
        restore: {
          $post: (
            input: { param: { workflowId: string; revision: string }; json: { expectedRevision: number } },
            options?: { init?: RequestInit },
          ) => Promise<Response>;
        };
      };
    };
  };
};

export function WorkflowRevisionHistory(props: {
  workflow: Pick<PublicWorkflow, "id" | "name" | "revision">;
  initialRevision?: number | null;
  canRestore: boolean;
  onChanged: (workflow: PublicWorkflow) => void;
  onClose: () => void;
}) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  const [items, setItems] = createSignal<RevisionPage["items"]>([]);
  const [selected, setSelected] = createSignal<PublicWorkflowRevision | null>(null);
  const [nextRevision, setNextRevision] = createSignal<number | null>(null);

  const loadPage = async (beforeRevision: number | null, signal: AbortSignal): Promise<RevisionPage> => {
    const response = await revisionApi[":workflowId"].revisions.$get(
      {
        param: { workflowId: props.workflow.id },
        query: { limit: "50", ...(beforeRevision ? { beforeRevision: String(beforeRevision) } : {}) },
      },
      { init: { signal } },
    );
    if (!response.ok) throw new Error(await errorMessage(response, t().loadHistoryFailed));
    return PublicGridsWorkflowRevisionListSchema.parse(await response.json());
  };

  const loadMut = mutations.create<{ page: RevisionPage; append: boolean }, { append: boolean }>({
    mutation: async ({ append }, { abortSignal }) => ({
      page: await loadPage(append ? nextRevision() : null, abortSignal),
      append,
    }),
    onSuccess: ({ page, append }) => {
      setItems((current) => (append ? [...current, ...page.items] : page.items));
      setNextRevision(page.nextRevision);
      if (!selected() && !props.initialRevision && page.items[0]) loadRevisionMut.mutate(page.items[0].revision);
    },
  });

  const loadRevisionMut = mutations.create<PublicWorkflowRevision, number>({
    mutation: async (revision, { abortSignal }) => {
      const response = await revisionApi[":workflowId"].revisions[":revision"].$get(
        { param: { workflowId: props.workflow.id, revision: String(revision) } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t().loadRevisionFailed));
      return PublicGridsWorkflowRevisionSchema.parse(await response.json());
    },
    onSuccess: setSelected,
  });

  const restoreMut = mutations.create<{ workflow: PublicWorkflow; restoredRevision: number }, PublicWorkflowRevision>({
    mutation: async (revision, { abortSignal }) => {
      const response = await revisionApi[":workflowId"].revisions[":revision"].restore.$post(
        {
          param: { workflowId: props.workflow.id, revision: String(revision.revision) },
          json: { expectedRevision: props.workflow.revision },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t().restoreRevisionFailed));
      return {
        workflow: PublicGridsWorkflowSchema.parse(await response.json()),
        restoredRevision: revision.revision,
      };
    },
    onSuccess: ({ workflow, restoredRevision }) => {
      toast.success(t().restoredRevision({ revision: restoredRevision }));
      props.onChanged(workflow);
      props.onClose();
    },
    onError: (error) => prompts.error(error.message),
  });

  const restore = async (revision: PublicWorkflowRevision) => {
    const confirmed = await prompts.confirm(t().restoreRevisionConfirm({ revision: revision.revision }), {
      title: t().restoreWorkflowRevision,
      icon: "ti ti-history",
      confirmText: t().restoreRevision,
    });
    if (confirmed) restoreMut.mutate(revision);
  };

  onMount(() => {
    loadMut.mutate({ append: false });
    if (props.initialRevision) loadRevisionMut.mutate(props.initialRevision);
  });

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={t().historyNamed({ name: props.workflow.name })}
        subtitle={t().historySubtitle}
        icon="ti ti-history"
        close={props.onClose}
      />
      <PanelDialog.Body>
        <div class="grid min-h-[32rem] flex-1 gap-2 md:grid-cols-[16rem_minmax(0,1fr)]">
          <nav class="paper flex min-h-0 flex-col overflow-auto p-2" aria-label={t().workflowRevisions}>
            <For
              each={items()}
              fallback={<Placeholder state={loadMut.loading() ? "loading" : "empty"} description={<>{t().noRevisions}</>} />}
            >
              {(revision) => (
                <button
                  type="button"
                  class={`flex w-full items-start justify-between gap-2 rounded-md p-2 text-left text-xs hover:bg-[var(--ui-surface-subtle)] ${
                    selected()?.revision === revision.revision ? "bg-[var(--ui-surface-subtle)]" : ""
                  }`}
                  disabled={loadRevisionMut.loading() || restoreMut.loading()}
                  onClick={() => loadRevisionMut.mutate(revision.revision)}
                >
                  <span>
                    <strong class="block text-primary">{t().revisionNumber({ revision: revision.revision })}</strong>
                    <span class="text-dimmed">{formatWorkflowRunDate(revision.createdAt, locale())}</span>
                  </span>
                  <span class="text-dimmed">r{revision.revision}</span>
                </button>
              )}
            </For>
            <Show when={nextRevision()}>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                class="mt-2"
                disabled={loadMut.loading()}
                onClick={() => loadMut.mutate({ append: true })}
              >
                <i class={loadMut.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-chevron-down"} /> {t().olderRevisions}
              </Button>
            </Show>
          </nav>
          <Show when={loadMut.error()}>
            {(error) => (
              <NoticeCard tone="danger" icon={false} class="md:col-span-2" role="alert">
                <span>{error().message}</span>
                <Button variant="ghost" size="sm" type="button" onClick={() => loadMut.mutate({ append: false })}>
                  <i class="ti ti-refresh" /> {t().retryHistory}
                </Button>
              </NoticeCard>
            )}
          </Show>
          <Show
            when={selected()}
            fallback={
              <Placeholder
                surface="paper"
                state={loadRevisionMut.loading() || loadMut.loading() ? "loading" : loadRevisionMut.error() ? "error" : "empty"}
                title={loadRevisionMut.error() ? t().loadRevisionFailed : t().selectRevision}
                description={loadRevisionMut.error()?.message}
                action={
                  loadRevisionMut.error() ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => loadRevisionMut.mutate(props.initialRevision ?? items()[0]?.revision ?? props.workflow.revision)}
                    >
                      <i class="ti ti-refresh" /> {t().retry}
                    </Button>
                  ) : undefined
                }
              />
            }
          >
            {(revision) => (
              <section class="flex min-h-0 flex-col gap-2">
                <div class="paper flex flex-wrap items-center justify-between gap-2 p-3">
                  <div>
                    <h3 class="text-sm font-semibold text-primary">{t().revisionNumber({ revision: revision().revision })}</h3>
                    <p class="text-xs text-dimmed">
                      {revision().name} · {formatWorkflowRunDate(revision().createdAt, locale())}
                    </p>
                  </div>
                  <Show when={props.canRestore && revision().revision !== props.workflow.revision}>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      disabled={restoreMut.loading()}
                      onClick={() => void restore(revision())}
                    >
                      <i class={restoreMut.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-history"} /> {t().restore}
                    </Button>
                  </Show>
                </div>
                <pre class="paper min-h-0 flex-1 overflow-auto p-3 text-xs leading-relaxed text-primary">
                  <code>{revision().source}</code>
                </pre>
              </section>
            )}
          </Show>
        </div>
      </PanelDialog.Body>
    </PanelDialog>
  );
}
