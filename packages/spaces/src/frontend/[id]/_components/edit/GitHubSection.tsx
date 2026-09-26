import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, prompts, SettingsGroup, StatusBadge, TextInput, toast } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { useSpaceMessages } from "../../messages";
import { readErrorMessage } from "./utils";

/** Admin-only: the Space's GitHub token for link previews. The token is write-only; only its presence is shown. */
export function GitHubSection(props: { spaceId: string; configured: boolean; onSettingsChange?: () => Promise<void> }) {
  const m = useSpaceMessages();
  const [configured, setConfigured] = createSignal(props.configured);
  const [token, setToken] = createSignal("");

  const applyState = async (next: { configured: boolean }) => {
    setConfigured(next.configured);
    setToken("");
    await props.onSettingsChange?.();
  };

  const saveMut = mutations.create<{ configured: boolean }, string>({
    mutation: async (value) => {
      const res = await apiClient[":id"]["github-token"].$put({ param: { id: props.spaceId }, json: { token: value } });
      if (!res.ok) throw new Error(await readErrorMessage(res, m.saveGithubTokenFailed));
      return res.json();
    },
    onSuccess: async (data) => {
      await applyState(data);
      toast.success(m.githubTokenSaved);
    },
    onError: (err) => prompts.error(err.message),
  });

  const removeMut = mutations.create<{ configured: boolean }, void>({
    mutation: async () => {
      const res = await apiClient[":id"]["github-token"].$delete({ param: { id: props.spaceId } });
      if (!res.ok) throw new Error(await readErrorMessage(res, m.removeGithubTokenFailed));
      return res.json();
    },
    onSuccess: async (data) => {
      await applyState(data);
      toast.success(m.githubTokenRemoved);
    },
    onError: (err) => prompts.error(err.message),
  });

  const busy = () => saveMut.loading() || removeMut.loading();
  let confirmPending = false;
  const confirmRemove = async () => {
    if (confirmPending || busy()) return;
    confirmPending = true;
    try {
      const confirmed = await prompts.confirm(m.removeGithubTokenConfirm, { title: m.removeGithubToken, variant: "danger" });
      if (confirmed) void removeMut.mutate();
    } finally {
      confirmPending = false;
    }
  };

  return (
    <SettingsGroup title={m.githubPreviews} description={m.githubPreviewsDescription}>
      <div class="flex flex-col gap-3">
        <StatusBadge
          tone={configured() ? "ok" : "neutral"}
          icon={configured() ? "ti ti-key" : null}
          label={configured() ? m.githubTokenConfigured : m.githubTokenNotConfigured}
        />
        <TextInput
          label={m.githubToken}
          description={m.githubTokenDescription}
          value={token}
          onValueChange={setToken}
          password
          autocomplete="off"
          disabled={busy()}
        />
      </div>
      <SettingsGroup.Action>
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={busy() || token().trim().length === 0}
          onClick={() => void saveMut.mutate(token().trim())}
        >
          <i class={`ti ${saveMut.loading() ? "ti-loader-2 animate-spin" : "ti-device-floppy"}`} aria-hidden="true" />
          {m.saveGithubToken}
        </Button>
        <Show when={configured()}>
          <Button type="button" variant="ghost" size="sm" disabled={busy()} onClick={() => void confirmRemove()}>
            <i class={`ti ${removeMut.loading() ? "ti-loader-2 animate-spin" : "ti-trash"}`} aria-hidden="true" />
            {m.removeGithubToken}
          </Button>
        </Show>
      </SettingsGroup.Action>
    </SettingsGroup>
  );
}
