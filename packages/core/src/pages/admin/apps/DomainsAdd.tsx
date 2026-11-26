import { coreClient } from "@k2b/cloud/clients/core";
import { useLocale } from "@k2b/ui";
import { Button, Dialog, Field, Input, Notice, Select } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { failure, STALE } from "./domains-api";
import { domainError, domainsMessages } from "./domains-messages";
import { type AppDomainEntry, primaries } from "./domains-model";
import { domainsState } from "./domains-state";

const api = coreClient.admin.apps;

/**
 * "Add domain" in the head of the open app, and its dialog: the host and, when the app has a primary domain, a 301
 * redirect to it. A refusal stays in the dialog with the input kept; a conflict that shows the list is old reads it
 * again. The domains view reads the list again after an add, and once more when the first check has had time.
 */
export default function DomainsAdd(props: { app: { id: string; name: string }; initial: AppDomainEntry[] }) {
  const locale = useLocale();
  const t = () => domainsMessages.resolve([locale()]).t;
  const [open, setOpen] = createSignal(false);
  const [host, setHost] = createSignal("");
  const [redirect, setRedirect] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const targets = () => primaries(domainsState.domains() ?? props.initial);
  const reread = () => domainsState.setRevision((value) => value + 1);
  const start = () => {
    setHost("");
    setRedirect("");
    setError(null);
    setOpen(true);
  };
  const add = async () => {
    if (!host().trim() || saving()) return;
    setSaving(true);
    setError(null);
    try {
      const response = await api[":appId"].domains
        .$post({ param: { appId: props.app.id }, json: { host: host().trim(), ...(redirect() ? { redirectTo: redirect() } : {}) } })
        .catch(() => null);
      if (!response?.ok) {
        const code = (await failure(response)).code;
        setError(domainError(t(), code));
        if (STALE.has(code ?? "")) reread();
        return;
      }
      setOpen(false);
      reread();
      // A new domain's first check runs in the background: read the list once more after a few seconds.
      setTimeout(reread, 6000);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Button icon="plus" disabled={domainsState.busy() !== null} onClick={start}>
        {t().add}
      </Button>
      <Dialog
        title={t().addTitle}
        open={open()}
        dismissible={!saving()}
        onOpenChange={(next) => {
          if (!next && !saving()) setOpen(false);
        }}
        foot={
          <>
            <Button disabled={saving()} onClick={() => setOpen(false)}>
              {t().cancel}
            </Button>
            <Button variant="primary" busy={saving()} disabled={!host().trim()} onClick={() => void add()}>
              {t().save}
            </Button>
          </>
        }
      >
        <Field name="host" label={t().host} hint={t().hostHelp} required>
          <Input
            value={host()}
            disabled={saving()}
            onInput={setHost}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.isComposing) void add();
            }}
          />
        </Field>
        <Show when={targets().length > 0}>
          <Field name="redirect" label={t().redirect}>
            <Select
              value={redirect()}
              onChange={setRedirect}
              options={[
                { value: "", label: t().noRedirect },
                ...targets().map((domain) => ({ value: domain.host, label: t().redirectTo({ host: domain.host }) })),
              ]}
            />
          </Field>
        </Show>
        <Show when={error()}>
          {(message) => (
            <Notice tone="bad" title={t().changeFailed}>
              {message()}
            </Notice>
          )}
        </Show>
      </Dialog>
    </>
  );
}
