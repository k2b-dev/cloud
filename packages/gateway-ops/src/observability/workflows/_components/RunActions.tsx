import type { WorkflowJsonValue } from "@k2b/cloud/workflows";
import { useLocale } from "@k2b/ui";
import { Button, confirm, Dialog, Field, Input, Menu, useToast } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { gatewayOpsMessages } from "../../../messages";
import { afterMenu } from "../../_components/after-menu";
import { apiClient } from "../api-client";

export type RunActionsProps = {
  runId: string;
  cancelable: boolean;
  /** The step whose external effect waits for an operator's evidence. */
  attentionStep: { stepKey: string; action: string | null } | null;
};

const responseError = async (response: Pick<Response, "json">, fallback: string): Promise<Error> => {
  const data = (await response.json().catch(() => null)) as { message?: unknown } | null;
  return new Error(typeof data?.message === "string" ? data.message : fallback);
};

/**
 * The two interventions the kernel can perform safely: cancel a run, and decide an ambiguous external effect with
 * evidence. Each asks first; a done deed reloads the run so the page shows the stored state.
 */
export default function RunActions(props: RunActionsProps) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  const toast = useToast();
  const [deciding, setDeciding] = createSignal<"succeeded" | "failed" | null>(null);
  const [output, setOutput] = createSignal("");
  const [message, setMessage] = createSignal("");
  const [code, setCode] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);

  const cancel = async () => {
    if (!(await confirm({ title: t().cancelRunQuestion, description: t().cancelRunWarning, confirm: t().cancelRun }))) return;
    const response = await apiClient.runs[":id"].cancel.$post({ param: { id: props.runId } });
    if (!response.ok) {
      toast((await responseError(response, t().cancelRunFailed)).message, { status: "bad" });
      return;
    }
    toast(t().runCanceled, { status: "ok" });
    location.reload();
  };

  const decide = async () => {
    const step = props.attentionStep;
    const state = deciding();
    if (!step || !state) return;
    let json: { state: "succeeded"; output?: WorkflowJsonValue } | { state: "failed"; message: string; code?: string };
    if (state === "succeeded") {
      const raw = output().trim();
      if (raw) {
        try {
          json = { state, output: JSON.parse(raw) as WorkflowJsonValue };
        } catch {
          setFailure(t().invalidConfirmedOutput);
          return;
        }
      } else json = { state };
    } else {
      if (!message().trim()) {
        setFailure(t().required);
        return;
      }
      json = { state, message: message().trim(), ...(code().trim() ? { code: code().trim() } : {}) };
    }
    setBusy(true);
    setFailure(null);
    try {
      const response = await apiClient.runs[":id"].attention[":step"].$post({ param: { id: props.runId, step: step.stepKey }, json });
      if (!response.ok) throw await responseError(response, t().resolveEffectFailed);
      setDeciding(null);
      toast(state === "succeeded" ? t().effectConfirmed : t().effectConfirmedFailed, { status: "ok" });
      location.reload();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t().resolveEffectFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Show when={props.attentionStep || props.cancelable}>
        <Menu
          label={t().actions}
          items={[
            ...(props.attentionStep
              ? [
                  { label: t().markSucceeded, icon: "check", onClick: afterMenu(() => setDeciding("succeeded")) },
                  { label: t().markFailed, icon: "x", onClick: afterMenu(() => setDeciding("failed")) },
                ]
              : []),
            ...(props.cancelable ? [{ label: t().cancelRun, icon: "player-stop", danger: true, onClick: afterMenu(cancel) }] : []),
          ]}
        />
      </Show>
      <Dialog
        title={deciding() === "failed" ? t().confirmEffectFailed : t().confirmEffectSucceeded}
        open={deciding() !== null}
        onOpenChange={(open) => {
          if (!open) setDeciding(null);
        }}
        foot={
          <>
            <Button onClick={() => setDeciding(null)}>{t().cancel}</Button>
            <Button icon={deciding() === "failed" ? "x" : "check"} busy={busy()} onClick={() => void decide()}>
              {deciding() === "failed" ? t().confirmFailure : t().confirmAndResume}
            </Button>
          </>
        }
      >
        <Show
          when={deciding() === "failed"}
          fallback={
            <Field label={t().confirmedOutput} hint={t().confirmSuccessEvidence} optional={t().optional} error={failure() ?? undefined}>
              <Input multiline value={output()} onInput={setOutput} placeholder='{"providerId":"..."}' />
            </Field>
          }
        >
          <Field label={t().failureExplanation} hint={t().confirmFailureEvidence} error={failure() ?? undefined}>
            <Input multiline value={message()} onInput={setMessage} placeholder={t().failureEvidencePlaceholder} />
          </Field>
          <Field label={t().failureCode} optional={t().optional}>
            <Input value={code()} onInput={setCode} placeholder="PROVIDER_REJECTED" />
          </Field>
        </Show>
      </Dialog>
    </>
  );
}
