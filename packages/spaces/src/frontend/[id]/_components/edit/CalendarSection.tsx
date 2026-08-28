import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, CopyButton, prompts, SettingsGroup, toast } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { useSpaceMessages } from "../../messages";
import { readErrorMessage } from "./utils";

export function CalendarSection(props: { spaceId: string; icalToken: string | null; baseUrl: string; isAdmin: boolean }) {
  const m = useSpaceMessages();
  const [token, setToken] = createSignal(props.icalToken);

  const regenerateMut = mutations.create<{ icalToken: string }, { spaceId: string }>({
    mutation: async ({ spaceId }) => {
      const res = await apiClient[":id"]["regenerate-ical-token"].$post({ param: { id: spaceId } });
      if (!res.ok) throw new Error(await readErrorMessage(res, m.regenerateTokenFailed));
      return res.json();
    },
    onSuccess: (data) => {
      setToken(data.icalToken);
      toast.success(m.calendarTokenRegenerated);
    },
    onError: (err) => prompts.error(err.message),
  });
  let confirmPending = false;
  const confirmRegenerate = async () => {
    if (confirmPending || regenerateMut.loading()) return;
    confirmPending = true;
    try {
      const confirmed = await prompts.confirm(m.regenerateTokenConfirm, {
        title: m.regenerateToken,
        variant: "danger",
      });
      if (confirmed) void regenerateMut.mutate({ spaceId: props.spaceId });
    } finally {
      confirmPending = false;
    }
  };

  const icalUrl = () => (token() ? `${props.baseUrl}/api/spaces/calendar/ical/${token()}.ics` : null);

  return (
    <>
      <SettingsGroup title={m.calendarFeed} description={m.calendarFeedDescription}>
        <Show when={icalUrl()} fallback={<p class="text-sm text-dimmed">{m.noCalendarUrl}</p>}>
          <div class="flex min-w-0 items-center gap-2">
            <code class="min-w-0 flex-1 truncate rounded-[var(--ui-radius-control)] bg-[var(--ui-field)] px-2 py-1.5 text-xs text-secondary">
              {icalUrl()!}
            </code>
            <CopyButton text={icalUrl()!} />
          </div>
        </Show>
        <Show when={props.isAdmin && icalUrl()}>
          <SettingsGroup.Action>
            <Button type="button" variant="ghost" size="sm" onClick={() => void confirmRegenerate()} disabled={regenerateMut.loading()}>
              <i class={`ti ${regenerateMut.loading() ? "ti-loader-2 animate-spin" : "ti-refresh"}`} aria-hidden="true" />
              {m.regenerateUrl}
            </Button>
          </SettingsGroup.Action>
        </Show>
      </SettingsGroup>

      <SettingsGroup title={m.calendarApps} description={m.calendarAppsDescription}>
        <div class="space-y-1 text-sm text-secondary">
          <p>
            <strong>Thunderbird:</strong> {m.thunderbirdInstructions}
          </p>
          <p>
            <strong>Google Calendar:</strong> {m.googleCalendarInstructions}
          </p>
          <p>
            <strong>Apple Calendar:</strong> {m.appleCalendarInstructions}
          </p>
          <p>
            <strong>Outlook:</strong> {m.outlookInstructions}
          </p>
        </div>
      </SettingsGroup>
    </>
  );
}
