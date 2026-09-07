import { mutation } from "@k2b/stdlib/solid";
import { Button, prompts, toast, useLocale } from "@k2b/ui";
import { gatewayOpsMessages } from "../../../messages";
import { syncApiClient } from "../client";

type Props = { appId: string; schedulerId: string; scheduleId: string };

const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? fallback;
};

export default function RunScheduleNowButton(props: Props) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const run = mutation.create<{ runId: string }, void>({
    mutation: async () => {
      const response = await syncApiClient.schedules[":app"][":scheduler"][":id"]["run-now"].$post({
        param: { app: props.appId, scheduler: props.schedulerId, id: props.scheduleId },
        json: {},
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, t.syncRunNowFailed));
      return response.json();
    },
    onSuccess: (result) => toast.success(t.syncRunAccepted({ scheduleId: props.scheduleId, runId: result.runId })),
    onError: (error) => prompts.error(error.message),
  });

  return (
    <Button type="button" variant="secondary" size="xs" disabled={run.loading()} onClick={() => run.mutate()}>
      <i class={`ti ${run.loading() ? "ti-loader-2 animate-spin" : "ti-player-play"}`} />
      {t.runNow}
    </Button>
  );
}
