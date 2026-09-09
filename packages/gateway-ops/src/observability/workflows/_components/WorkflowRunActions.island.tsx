import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { Button, prompts, toast, useLocale } from "@k2b/ui";
import type { WorkflowJsonValue, WorkflowRunState } from "@k2b/cloud/workflows";
import { apiClient } from "../api-client";
import { gatewayOpsMessages } from "../../../messages";

type AttentionStep = {
  stepKey: string;
  action: string | null;
};

type Props = {
  runId: string;
  state: WorkflowRunState;
  attentionStep?: AttentionStep;
};

const responseError = async (response: Response, fallback: string): Promise<Error> => {
  const data = (await response.json().catch(() => null)) as { message?: unknown } | null;
  return new Error(typeof data?.message === "string" ? data.message : fallback);
};

export default function WorkflowRunActions(props: Props) {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  const cancel = mutation.create<{ canceled: true }, void>({
    mutation: async () => {
      const confirmed = await prompts.confirm(
        t.cancelRunWarning,
        {
          title: t.cancelRunQuestion,
          icon: "ti ti-player-stop",
          confirmText: t.cancelRun,
          variant: "danger",
        },
      );
      if (!confirmed) throw new DOMException("Canceled", "AbortError");

      const response = await apiClient.runs[":id"].cancel.$post({ param: { id: props.runId } });
      if (!response.ok) throw await responseError(response, t.cancelRunFailed);
      return response.json();
    },
    onSuccess: () => {
      toast.success(t.runCanceled);
      refreshCurrentPath();
    },
    onError: (error) => {
      if (error.name !== "AbortError") prompts.error(error.message);
    },
  });

  const resolveSucceeded = mutation.create<{ resolved: true }, void>({
    mutation: async () => {
      const step = props.attentionStep;
      if (!step) throw new Error(t.noEffectAwaitingResolution);
      const values = await prompts.form({
        title: t.confirmEffectSucceeded,
        icon: "ti ti-check",
        confirmText: t.confirmAndResume,
        variant: "success",
        fields: {
          output: {
            type: "text" as const,
            label: t.confirmedOutput,
            multiline: true,
            lines: 4,
            placeholder: '{"providerId":"..."}',
          },
        },
      });
      if (!values) throw new DOMException("Canceled", "AbortError");

      const raw = values.output?.trim() ?? "";
      let output: WorkflowJsonValue | undefined;
      if (raw) {
        try {
          output = JSON.parse(raw) as WorkflowJsonValue;
        } catch {
          throw new Error(t.invalidConfirmedOutput);
        }
      }

      const response = await apiClient.runs[":id"].attention[":step"].$post({
        param: { id: props.runId, step: step.stepKey },
        json: output === undefined ? { state: "succeeded" } : { state: "succeeded", output },
      });
      if (!response.ok) throw await responseError(response, t.resolveEffectFailed);
      return response.json();
    },
    onSuccess: () => {
      toast.success(t.effectConfirmed);
      refreshCurrentPath();
    },
    onError: (error) => {
      if (error.name !== "AbortError") prompts.error(error.message);
    },
  });

  const resolveFailed = mutation.create<{ resolved: true }, void>({
    mutation: async () => {
      const step = props.attentionStep;
      if (!step) throw new Error(t.noEffectAwaitingResolution);
      const values = await prompts.form({
        title: t.confirmEffectFailed,
        icon: "ti ti-x",
        confirmText: t.confirmFailure,
        variant: "danger",
        fields: {
          message: {
            type: "text" as const,
            label: t.failureExplanation,
            required: true,
            multiline: true,
            lines: 3,
            placeholder: t.failureEvidencePlaceholder,
          },
          code: {
            type: "text" as const,
            label: t.failureCodeOptional,
            placeholder: "PROVIDER_REJECTED",
          },
        },
      });
      if (!values) throw new DOMException("Canceled", "AbortError");

      const code = values.code?.trim() ?? "";
      const response = await apiClient.runs[":id"].attention[":step"].$post({
        param: { id: props.runId, step: step.stepKey },
        json: {
          state: "failed",
          message: values.message.trim(),
          ...(code ? { code } : {}),
        },
      });
      if (!response.ok) throw await responseError(response, t.resolveEffectFailed);
      return response.json();
    },
    onSuccess: () => {
      toast.success(t.effectConfirmedFailed);
      refreshCurrentPath();
    },
    onError: (error) => {
      if (error.name !== "AbortError") prompts.error(error.message);
    },
  });

  const cancelable = () => ["queued", "running", "waiting"].includes(props.state);

  return (
    <div class="flex flex-wrap items-center justify-end gap-1">
      {props.attentionStep ? (
        <>
          <Button
            type="button"
            variant="success"
            size="sm"
            disabled={resolveSucceeded.loading() || resolveFailed.loading()}
            onClick={() => resolveSucceeded.mutate()}
            title={t.confirmSuccessEvidence}
          >
            <i class="ti ti-check" />
            {t.markSucceeded}
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={resolveSucceeded.loading() || resolveFailed.loading()}
            onClick={() => resolveFailed.mutate()}
            title={t.confirmFailureEvidence}
          >
            <i class="ti ti-x" />
            {t.markFailed}
          </Button>
        </>
      ) : null}
      {cancelable() ? (
        <Button type="button" variant="danger" size="sm" disabled={cancel.loading()} onClick={() => cancel.mutate()}>
          <i class={cancel.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-player-stop"} />
          {t.cancelRun}
        </Button>
      ) : null}
    </div>
  );
}
