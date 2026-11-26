import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  DataTable,
  type DataTableColumn,
  dialogCore,
  NoticeCard,
  PanelDialog,
  panelDialogWorkspaceOptions,
  StatusBadge,
  useLocale,
} from "@k2b/ui";
import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import type { z } from "zod";
import type { PublicGridsWorkflowEmailDeliveryListSchema } from "../../../api/workflow-public-contracts";
import { workflowMessages } from "./messages";
import { formatWorkflowRunDate as formatDate } from "./workflow-display";

export type WorkflowEmailDeliveryPage = z.infer<typeof PublicGridsWorkflowEmailDeliveryListSchema>;
type WorkflowEmailDelivery = WorkflowEmailDeliveryPage["items"][number];

type EmailActivityArgs = {
  title: string;
  subtitle: string;
  /** One page of deliveries from `cursor` on (the first page without one). */
  load: (cursor?: string | null, signal?: AbortSignal) => Promise<WorkflowEmailDeliveryPage>;
  /** Changes when a run finished, so the open list reads again. */
  refresh: Accessor<number>;
};

function EmailDeliveryTable(props: {
  deliveries: WorkflowEmailDelivery[];
  loading?: boolean;
  nextCursor?: string | null;
  onLoadMore?: () => void;
}) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  const recipients = (delivery: WorkflowEmailDelivery) =>
    delivery.recipients.map((recipient) => `${recipient.kind}:${recipient.recipient}`).join(", ") || "-";
  const columns = createMemo<DataTableColumn<WorkflowEmailDelivery>[]>(() => [
    { id: "status", header: t().status, value: (delivery) => delivery.status },
    { id: "subject", header: t().subject, value: (delivery) => delivery.subject, cellClass: "max-w-72" },
    { id: "recipients", header: t().recipients, value: recipients, cellClass: "max-w-72" },
    { id: "sent", header: t().sent, value: (delivery) => delivery.createdAt, cellClass: "whitespace-nowrap" },
  ]);
  return (
    <section class="flex min-h-0 flex-1 flex-col">
      <DataTable
        ariaLabel={t().workflowEmailDeliveries}
        rows={props.deliveries}
        columns={columns()}
        getRowId={(delivery) =>
          [delivery.createdAt, delivery.workflowRunId ?? "", delivery.templateId ?? "", delivery.subject ?? ""].join(":")
        }
        density="compact"
        highlightColumns={false}
        class="paper min-h-[20rem] flex-1 overflow-auto"
        hasMore={!!props.nextCursor}
        loadingMore={props.loading}
        onLoadMore={props.onLoadMore}
        empty={props.loading ? t().loadingEmailDeliveries : t().noWorkflowEmails}
        renderCell={({ row: delivery, col, render, value }) => {
          if (col.id === "status") {
            return (
              <span class="flex min-w-0 flex-col items-start gap-1">
                <StatusBadge
                  tone={delivery.status === "failed" ? "error" : "ok"}
                  label={delivery.status === "failed" ? t().failed : t().sent}
                />
                <Show when={delivery.error}>
                  {(error) => <span class="block max-w-48 truncate text-red-600 dark:text-red-400">{error()}</span>}
                </Show>
              </span>
            );
          }
          if (col.id === "sent") return <span class="text-dimmed">{formatDate(delivery.createdAt, locale())}</span>;
          if (col.id === "recipients") return <span class="text-dimmed">{recipients(delivery)}</span>;
          return render(value);
        }}
      />
    </section>
  );
}

/** The e-mails a workflow sent, newest first, in its v1 dialog; it reads again when a run finishes while it is open. */
function WorkflowEmailActivity(props: EmailActivityArgs & { close: () => void }) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  const [deliveries, setDeliveries] = createSignal<WorkflowEmailDelivery[]>([]);
  const [nextCursor, setNextCursor] = createSignal<string | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const first = mutations.create<void, void>({
    // a finished run replaces a read in flight
    concurrency: "replace",
    mutation: async (_, { abortSignal }) => {
      const page = await props.load(null, abortSignal);
      setDeliveries(page.items);
      setNextCursor(page.nextCursor ?? null);
    },
    onSuccess: () => setLoadError(null),
    onError: (error) => setLoadError(error.message),
  });
  const more = mutations.create<void, void>({
    mutation: async (_, { abortSignal }) => {
      const cursor = nextCursor();
      if (!cursor) return;
      const page = await props.load(cursor, abortSignal);
      setDeliveries((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor ?? null);
    },
    onSuccess: () => setLoadError(null),
    onError: (error) => setLoadError(error.message),
  });
  createEffect(on(props.refresh, () => first.mutate()));
  onCleanup(() => {
    first.abort();
    more.abort();
  });
  return (
    <PanelDialog surface="floating">
      <PanelDialog.Header title={props.title} subtitle={props.subtitle} icon="ti ti-mail" close={() => props.close()} />
      <PanelDialog.Body>
        <div class="flex min-h-[24rem] flex-1 flex-col gap-2">
          <Show when={loadError()}>
            {(message) => (
              <NoticeCard tone="danger" bodyClass="flex items-center justify-between gap-3" role="alert">
                <span>{message()}</span>
                <Button variant="ghost" size="sm" type="button" class="shrink-0" onClick={() => first.mutate()}>
                  <i class="ti ti-refresh" aria-hidden="true" /> {t().retry}
                </Button>
              </NoticeCard>
            )}
          </Show>
          <EmailDeliveryTable
            deliveries={deliveries()}
            loading={first.loading() || more.loading()}
            nextCursor={nextCursor()}
            onLoadMore={() => more.mutate()}
          />
        </div>
      </PanelDialog.Body>
    </PanelDialog>
  );
}

export const openWorkflowEmailActivity = (args: EmailActivityArgs) =>
  dialogCore.open<void>((close) => <WorkflowEmailActivity {...args} close={close} />, panelDialogWorkspaceOptions);
