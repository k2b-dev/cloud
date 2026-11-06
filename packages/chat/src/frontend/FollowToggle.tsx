import { Button, toast } from "@k2b/ui";
import { createSignal, type JSX } from "solid-js";
import { errorMessage, useChatMessages } from "./chat-dialog";
export function FollowToggle(props: { following: boolean; onToggle: (on: boolean) => Promise<unknown> }): JSX.Element {
  const t = useChatMessages();
  const [saving, setSaving] = createSignal(false);
  const toggle = async () => {
    if (saving()) return;
    setSaving(true);
    try {
      await props.onToggle(!props.following);
    } catch (failure) {
      toast.error(errorMessage(failure, t().followFailed));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Button
      size="sm"
      variant={props.following ? "subtle" : "ghost"}
      class="chat-follow"
      aria-pressed={props.following}
      loading={saving()}
      tooltip={t().followHint}
      onClick={() => void toggle()}
    >
      <i class={props.following ? "ti ti-bell-ringing" : "ti ti-bell-plus"} aria-hidden="true" />
      {props.following ? t().followOn : t().followOff}
    </Button>
  );
}
