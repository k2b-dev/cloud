import { Button, InlineGuidance, TextInput } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { publicClient } from "./public-client";
import { useSharePasswordMessages } from "./share-password-messages";

export default function PublicShareUnlock(props: { token: string; kind: "download" | "inbox" }) {
  const t = useSharePasswordMessages();
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy() || !password()) return;
    setBusy(true);
    setError("");
    try {
      const response = await publicClient[":kind"][":token"].api.unlock.$post({
        param: { kind: props.kind === "inbox" ? "inbox" : "s", token: props.token },
        json: { password: password() },
      });
      setPassword("");
      if (!response.ok) {
        setError(Number(response.status) === 429 ? t().limited : t().failed);
        return;
      }
      window.location.reload();
    } catch {
      setError(t().failed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
      <TextInput
        password
        label={t().enterPassword}
        value={password}
        onValueChange={setPassword}
        autocomplete="current-password"
        required
        maxLength={256}
        disabled={busy()}
      />
      <Show when={error()}>
        <div role="alert">
          <InlineGuidance tone="danger">{error()}</InlineGuidance>
        </div>
      </Show>
      <Button type="submit" variant="primary" loading={busy()} disabled={!password()}>
        {t().unlock}
      </Button>
    </form>
  );
}
