import { mutation } from "@k2b/stdlib/solid";
import { Button, prompts, StatusBadge, useLocale } from "@k2b/ui";
import { createSignal, onCleanup } from "solid-js";
import { z } from "zod";
import { gatewayOpsMessages } from "../../../messages";
import { syncApiClient } from "../client";
import { syncOpsMessages } from "../ops-messages";

type Props = { appId: string; schedulerId: string; scheduleId: string; lastRunId?: string | null };
const acceptedSchema = z.object({ runId: z.string() });
const outcomeSchema = z.object({ completed: z.boolean(), error: z.string().nullable() });
const errorSchema = z.object({ message: z.string() });

export default function RunScheduleNowButton(props: Props) {
  const locale = useLocale()();
  const { t } = gatewayOpsMessages.resolve([locale]);
  const { t: o } = syncOpsMessages.resolve([locale]);
  const [runId, setRunId] = createSignal(props.lastRunId ?? null);
  const [outcome, setOutcome] = createSignal<z.infer<typeof outcomeSchema> | null>(null);
  const [requestId, setRequestId] = createSignal<string | null>(null);
  const [readError, setReadError] = createSignal(false);
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const param = () => ({ app: props.appId, scheduler: props.schedulerId, id: props.scheduleId });
  const check = mutation.create<void, void>({
    mutation: async () => {
      const id = runId();
      if (!id) return;
      setReadError(false);
      const response = await syncApiClient.schedules[":app"][":scheduler"][":id"].runs[":runId"].$get(
        { param: { ...param(), runId: id }, query: { timeoutMs: "5000" } },
        { init: { signal: controller.signal } },
      );
      if (!response.ok) throw new Error(o.checkFailed);
      const result = outcomeSchema.parse(await response.json());
      if (!controller.signal.aborted) setOutcome(result);
    },
    onError: () => {
      if (!controller.signal.aborted) setReadError(true);
    },
  });
  const run = mutation.create<void, void>({
    mutation: async () => {
      if (!(await prompts.confirm(o.confirmRun, { title: t.runNow, confirmText: t.runNow }))) return;
      const intentId = requestId() ?? crypto.randomUUID();
      setRequestId(intentId);
      const response = await syncApiClient.schedules[":app"][":scheduler"][":id"]["run-now"].$post(
        { param: param(), json: { requestId: intentId } },
        { init: { signal: controller.signal } },
      );
      if (!response.ok) {
        const body = errorSchema.safeParse(await response.json().catch(() => null));
        throw new Error(body.success ? body.data.message : t.syncRunNowFailed);
      }
      const result = acceptedSchema.parse(await response.json());
      if (controller.signal.aborted) return;
      setRequestId(null);
      setRunId(result.runId);
      setOutcome({ completed: false, error: null });
      await check.mutate();
    },
    onError: (error) => {
      if (!controller.signal.aborted) prompts.error(error.message);
    },
  });
  const busy = () => run.loading() || check.loading();
  return (
    <div class="flex flex-col items-end gap-1">
      <div class="flex gap-1">
        <Button type="button" variant="secondary" size="xs" disabled={busy()} onClick={() => run.mutate()}>
          {t.runNow}
        </Button>
        {runId() ? (
          <Button type="button" variant="secondary" size="xs" disabled={busy()} onClick={() => check.mutate()}>
            {o.check}
          </Button>
        ) : null}
      </div>
      {requestId() && !run.loading() ? (
        <p class="max-w-xs text-xs text-amber-600">
          {o.acceptUnknown} <span class="font-mono select-all">{requestId()}</span>
        </p>
      ) : null}
      {runId() ? (
        <span class="font-mono text-[10px] break-all select-all">
          {o.runId}: {runId()}
        </span>
      ) : null}
      <div role="status" aria-live="polite">
        {readError() ? (
          <span class="text-xs text-amber-600">{o.checkFailed}</span>
        ) : outcome() ? (
          <StatusBadge
            variant="dot"
            tone={outcome()?.error ? "error" : outcome()?.completed ? "ok" : "running"}
            label={outcome()?.error ? o.failed : outcome()?.completed ? o.completed : o.pending}
          />
        ) : null}
      </div>
      {outcome()?.error ? <p class="max-w-xs whitespace-pre-wrap break-words text-xs text-red-600">{outcome()?.error}</p> : null}
    </div>
  );
}
