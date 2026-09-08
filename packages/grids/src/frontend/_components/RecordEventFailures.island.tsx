import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { Button, DataTable, type DataTableColumn, prompts, toast, useLocale } from "@k2b/ui";
import { apiClient } from "../../api/client";
import type { RecordEventDeliveryFailure } from "../../service/record-event-delivery-failures";
import { gridsAdminMessages } from "../admin-messages";

type Failure = Omit<RecordEventDeliveryFailure, "baseId" | "payload">;

export default function RecordEventFailures(props: { baseId: string; items: Failure[] }) {
  const locale = useLocale();
  const t = () => gridsAdminMessages.resolve([locale()]).t;
  const replay = mutation.create<void, string>({
    mutation: async (failureId) => {
      const response = await apiClient.admin.bases[":baseId"]["record-event-failures"][":failureId"].replay.$post({
        param: { baseId: props.baseId, failureId },
        json: {},
      });
      if (!response.ok) throw new Error(t().eventReplayFailed);
    },
    onSuccess: () => {
      toast.success(t().eventReplayAccepted);
      void refreshCurrentPath();
    },
    onError: (error) => prompts.error(error.message),
  });
  const columns = (): DataTableColumn<Failure>[] => [
    { id: "event", header: t().eventId, value: (row) => row.eventId },
    { id: "consumer", header: t().eventConsumer, value: (row) => row.consumerGroup },
    { id: "attempts", header: t().eventAttempts, value: (row) => row.attempts },
    { id: "error", header: t().eventError, value: (row) => row.error, cellClass: "max-w-lg whitespace-normal break-words" },
    { id: "status", header: t().eventStatus, value: (row) => (row.status === "dead" ? t().eventDead : t().eventRetrying) },
    { id: "actions", header: t().eventReplay },
  ];
  return (
    <DataTable
      ariaLabel={t().eventFailures}
      rows={props.items}
      columns={columns()}
      getRowId={(row) => row.id}
      empty={t().noEventFailures}
      renderCell={({ row, col, render, value }) =>
        col.id === "actions" ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={row.status !== "dead" || replay.loading()}
            onClick={() => replay.mutate(row.id)}
          >
            {t().eventReplay}
          </Button>
        ) : (
          render(value)
        )
      }
    />
  );
}
