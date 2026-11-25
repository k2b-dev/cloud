import { mutation as mutations } from "@k2b/stdlib/solid";
import { Bar, Button, Chip, confirm, Facts, Field, Input, Section, useToast } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { useSpaceMessages } from "../../messages";
import { readErrorMessage } from "./utils";

/** Admin-only: the Space's GitHub token for link previews. The token is write-only; only its presence is shown. */
export function GitHubSection(props: { spaceId: string; configured: boolean; onSettingsChange?: () => Promise<void> }) {
  const m = useSpaceMessages();
  const toast = useToast();
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
      toast(m.githubTokenSaved, { status: "ok" });
    },
    onError: (err) => toast(err.message, { status: "bad" }),
  });

  const removeMut = mutations.create<{ configured: boolean }, void>({
    mutation: async () => {
      const res = await apiClient[":id"]["github-token"].$delete({ param: { id: props.spaceId } });
      if (!res.ok) throw new Error(await readErrorMessage(res, m.removeGithubTokenFailed));
      return res.json();
    },
    onSuccess: async (data) => {
      await applyState(data);
      toast(m.githubTokenRemoved, { status: "ok" });
    },
    onError: (err) => toast(err.message, { status: "bad" }),
  });

  const busy = () => saveMut.loading() || removeMut.loading();
  let confirmPending = false;
  const confirmRemove = async () => {
    if (confirmPending || busy()) return;
    confirmPending = true;
    try {
      const confirmed = await confirm({
        title: m.removeGithubToken,
        description: m.removeGithubTokenConfirm,
        confirm: m.removeGithubToken,
      });
      if (confirmed) void removeMut.mutate();
    } finally {
      confirmPending = false;
    }
  };

  return (
    <Section icon="brand-github" title={m.githubPreviews} summary={m.githubPreviewsDescription}>
      <Facts
        items={[
          {
            label: m.githubToken,
            value: configured() ? <Chip status="ok">{m.githubTokenConfigured}</Chip> : <Chip>{m.githubTokenNotConfigured}</Chip>,
          },
        ]}
      />
      <Field label={m.githubToken} name="github-token" hint={m.githubTokenDescription}>
        <Input type="password" value={token()} disabled={busy()} onInput={setToken} />
      </Field>
      <Bar
        end={
          <>
            <Show when={configured()}>
              <Button icon="trash" busy={removeMut.loading()} disabled={busy()} onClick={() => void confirmRemove()}>
                {m.removeGithubToken}
              </Button>
            </Show>
            <Button
              busy={saveMut.loading()}
              disabled={busy() || token().trim().length === 0}
              onClick={() => void saveMut.mutate(token().trim())}
            >
              {m.saveGithubToken}
            </Button>
          </>
        }
      />
    </Section>
  );
}
