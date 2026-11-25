import { useLocale } from "@k2b/ui";
import { Button, Chip, confirm, Inline, useToast } from "@k2b/ui/v2";
import { createSignal, onCleanup, Show } from "solid-js";
import { z } from "zod";
import { gatewayOpsMessages } from "../../../messages";
import { syncApiClient } from "../client";
import { syncOpsMessages } from "../ops-messages";

type Props = { appId: string; schedulerId: string; scheduleId: string; lastRunId?: string | null };
const acceptedSchema = z.object({ runId: z.string() });
const outcomeSchema = z.object({ completed: z.boolean(), error: z.string().nullable() });
const errorSchema = z.object({ message: z.string() });

/**
 * "Run now" for one schedule: asks, starts one durable manual run (a repeated press after an unclear answer reuses its
 * request ID, so the run is not started twice), then reads its outcome once. Nothing polls.
 */
export default function RunNow(props: Props) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  const o = () => syncOpsMessages.resolve([locale()]).t;
  const toast = useToast();
  const [runId, setRunId] = createSignal(props.lastRunId ?? null);
  const [outcome, setOutcome] = createSignal<z.infer<typeof outcomeSchema> | null>(null);
  const [requestId, setRequestId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const param = () => ({ app: props.appId, scheduler: props.schedulerId, id: props.scheduleId });

  const check = async () => {
    const id = runId();
    if (!id) return;
    const response = await syncApiClient.schedules[":app"][":scheduler"][":id"].runs[":runId"].$get(
      { param: { ...param(), runId: id }, query: { timeoutMs: "5000" } },
      { init: { signal: controller.signal } },
    );
    if (!response.ok) throw new Error(o().checkFailed);
    const result = outcomeSchema.parse(await response.json());
    if (!controller.signal.aborted) setOutcome(result);
    if (result.error) toast(result.error, { status: "bad" });
  };
  const guarded = async (deed: () => Promise<void>, failed: string) => {
    setBusy(true);
    try {
      await deed();
    } catch (error) {
      if (!controller.signal.aborted) toast(error instanceof Error ? error.message : failed, { status: "bad" });
    } finally {
      setBusy(false);
    }
  };
  const run = () =>
    guarded(async () => {
      if (!(await confirm({ title: t().runNow, description: o().confirmRun, confirm: t().runNow }))) return;
      const intentId = requestId() ?? crypto.randomUUID();
      setRequestId(intentId);
      const response = await syncApiClient.schedules[":app"][":scheduler"][":id"]["run-now"].$post(
        { param: param(), json: { requestId: intentId } },
        { init: { signal: controller.signal } },
      );
      if (!response.ok) {
        const body = errorSchema.safeParse(await response.json().catch(() => null));
        throw new Error(body.success ? body.data.message : t().syncRunNowFailed);
      }
      const result = acceptedSchema.parse(await response.json());
      if (controller.signal.aborted) return;
      setRequestId(null);
      setRunId(result.runId);
      setOutcome({ completed: false, error: null });
      toast(t().syncRunAccepted({ scheduleId: props.scheduleId, runId: result.runId }), { status: "ok" });
      await check();
    }, t().syncRunNowFailed);

  const state = () => {
    const value = outcome();
    if (requestId() && !busy()) return <Chip status="warn">{o().acceptUnclear}</Chip>;
    if (!value) return null;
    if (value.error) return <Chip status="bad">{o().failed}</Chip>;
    return value.completed ? <Chip status="ok">{o().completed}</Chip> : <Chip>{o().pending}</Chip>;
  };
  return (
    <Inline>
      {state()}
      <Show when={runId()}>
        <Button variant="text" disabled={busy()} onClick={() => void guarded(check, o().checkFailed)}>
          {o().check}
        </Button>
      </Show>
      <Button variant="text" busy={busy()} onClick={() => void run()}>
        {t().runNow}
      </Button>
    </Inline>
  );
}
