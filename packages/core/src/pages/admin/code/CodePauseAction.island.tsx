import { Button, NoticeCard, prompts, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { z } from "zod";
import { CodeAdminRequestError, postCodeAdmin, reloadCodeArea } from "./client";
import { codeAdminMessages } from "./messages";

/**
 * Pause or resume one Code from Administration › Code. Cloud admins may pause any Code; resuming rechecks the
 * approval of the active version under the current policy on the server.
 */
export default function CodePauseAction(props: { codeId: string; title: string; paused: boolean }) {
  const locale = useLocale();
  const t = () => codeAdminMessages.resolve([locale()]).t;
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);
  const change = async () => {
    const paused = !props.paused;
    const confirmed = await prompts.confirm(paused ? t().pauseBody : t().resumeBody, {
      title: paused ? t().pauseTitle({ title: props.title }) : t().resumeTitle({ title: props.title }),
      confirmText: paused ? t().pause : t().resume,
      cancelText: t().cancel,
    });
    if (!confirmed) return;
    setBusy(true);
    setFailure(null);
    try {
      await postCodeAdmin("pause", { codeId: props.codeId, paused }, z.object({ state: z.enum(["paused", "active"]) }));
      reloadCodeArea();
    } catch (error) {
      setBusy(false);
      setFailure(
        !(error instanceof CodeAdminRequestError) || error.status < 400 || error.status >= 500
          ? `${t().unknownTitle} ${t().reload}`
          : error.status === 409 && !paused
            ? error.code === "code_policy_never" || error.code === "code_sends_not_yet"
              ? t().resumeForbidden
              : error.code === "code_approval_required" || error.code === "code_approval_revoked" || error.code === "code_hash_mismatch"
                ? t().resumeRefused
                : t().pauseFailed
            : t().pauseFailed,
      );
    }
  };
  return (
    <div class="grid gap-2">
      <div>
        <Button variant="secondary" size="sm" loading={busy()} onClick={() => void change()}>
          <i class={props.paused ? "ti ti-player-play" : "ti ti-player-pause"} aria-hidden="true" />
          {props.paused ? t().resume : t().pause}
        </Button>
      </div>
      <Show when={failure()}>{(message) => <NoticeCard tone="danger" title={message()} />}</Show>
    </div>
  );
}
