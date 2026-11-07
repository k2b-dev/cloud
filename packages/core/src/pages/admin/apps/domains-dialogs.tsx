import { coreClient } from "@k2b/cloud/clients/core";
import { mutation } from "@k2b/stdlib/solid";
import { Button, dialogCore, NoticeCard, PanelDialog, panelDialogOptions, Select, TextInput } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { domainError, domainsMessages } from "./domains-messages";
import { type AppDomainEntry, primaries } from "./domains-model";

const api = coreClient.admin.apps;
type App = { id: string; name: string };

/** Reads the stable `code` of a failed domain request; a lost connection has none and reads as "try again". */
export const failure = async (response: { json(): Promise<unknown> } | null) => {
  const body = response ? ((await response.json().catch(() => null)) as { code?: string } | null) : null;
  return Object.assign(new Error(body?.code ?? "unknown"), { code: body?.code });
};

/** Adds a domain, optionally as a 301 alias of a primary domain. Conflicts stay in the dialog with the input kept. */
/** Conflicts that mean the shown list is old: read it again while the dialog keeps the person's input. */
const STALE = new Set(["APP_DOMAIN_REFERENCED", "APP_DOMAIN_REDIRECT_TARGET", "APP_DOMAIN_NOT_FOUND"]);

/** `onChanged(true)` after an add, `onChanged(false)` when a conflict showed that the list is old. */
export const openAddDomainDialog = (app: App, domains: readonly AppDomainEntry[], locale: string, onChanged: (added: boolean) => void) =>
  dialogCore.open<void>(
    (close, context) => {
      const t = domainsMessages.resolve([locale]).t;
      const [host, setHost] = createSignal("");
      const [redirect, setRedirect] = createSignal<string | null>(null);
      const add = mutation.create({
        mutation: async (_: void, { abortSignal }) => {
          const response = await api[":appId"].domains
            .$post(
              { param: { appId: app.id }, json: { host: host().trim(), ...(redirect() ? { redirectTo: redirect()! } : {}) } },
              { init: { signal: abortSignal } },
            )
            .catch(() => null);
          if (!response?.ok) throw await failure(response);
        },
        onSuccess: () => {
          close();
          onChanged(true);
        },
        onError: (error) => {
          if (STALE.has((error as Error & { code?: string }).code ?? "")) onChanged(false);
        },
      });
      onCleanup(() => add.abort());
      context.setDismissHandler(() => {
        if (!add.loading()) close();
      });
      const submit = (event: SubmitEvent) => {
        event.preventDefault();
        if (host().trim() && !add.loading()) void add.mutate();
      };
      return (
        <form class="contents" onSubmit={submit} data-domain-add>
          <PanelDialog>
            <PanelDialog.Header
              title={t.addTitle}
              subtitle={app.name}
              icon="ti ti-world"
              close={() => close()}
              closeDisabled={add.loading()}
            />
            <PanelDialog.Body>
              <div class="flex flex-col gap-3">
                <TextInput
                  label={t.host}
                  value={host}
                  onValueChange={setHost}
                  description={t.hostHelp}
                  monospace
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck={false}
                  required
                  disabled={add.loading()}
                />
                <Show when={primaries(domains).length > 0}>
                  <Select
                    label={t.redirect}
                    value={redirect}
                    onValueChange={setRedirect}
                    placeholder={t.noRedirect}
                    clearable
                    disabled={add.loading()}
                    options={primaries(domains).map((domain) => ({ id: domain.host, label: t.redirectTo({ host: domain.host }) }))}
                  />
                </Show>
                <Show when={add.error()}>
                  {(error) => (
                    <NoticeCard tone="danger" icon="ti ti-alert-circle" role="alert">
                      {domainError(t, (error() as Error & { code?: string }).code)}
                    </NoticeCard>
                  )}
                </Show>
              </div>
            </PanelDialog.Body>
            <PanelDialog.Footer>
              <Button variant="secondary" disabled={add.loading()} onClick={() => close()}>
                {t.cancel}
              </Button>
              <Button type="submit" loading={add.loading()} disabled={!host().trim()}>
                {add.loading() ? t.saving : t.save}
              </Button>
            </PanelDialog.Footer>
          </PanelDialog>
        </form>
      );
    },
    { ...panelDialogOptions, ariaLabel: domainsMessages.resolve([locale]).t.addTitle, initialFocus: "first-input" },
  );

/** Removes one domain after asking. A domain others redirect to cannot go; the menu says so before this opens. */
export const openRemoveDomainDialog = (app: App, host: string, locale: string, onRemoved: () => void) =>
  dialogCore.open<void>(
    (close, context) => {
      const t = domainsMessages.resolve([locale]).t;
      const remove = mutation.create({
        mutation: async (_: void, { abortSignal }) => {
          const response = await api[":appId"].domains[":host"]
            .$delete({ param: { appId: app.id, host } }, { init: { signal: abortSignal } })
            .catch(() => null);
          if (!response?.ok) throw await failure(response);
        },
        onSuccess: () => {
          close();
          onRemoved();
        },
        onError: (error) => {
          // The list is old (gone already, or another domain now redirects here): read it again, keep the message.
          if (STALE.has((error as Error & { code?: string }).code ?? "")) onRemoved();
        },
      });
      onCleanup(() => remove.abort());
      context.setDismissHandler(() => {
        if (!remove.loading()) close();
      });
      return (
        <PanelDialog>
          <div class="contents" data-domain-remove>
            <PanelDialog.Header
              title={t.removeTitle({ host })}
              subtitle={app.name}
              icon="ti ti-trash"
              close={() => close()}
              closeDisabled={remove.loading()}
            />
            <PanelDialog.Body>
              <div class="flex flex-col gap-3">
                <p>{t.removeText({ host, app: app.name })}</p>
                <Show when={remove.error()}>
                  {(error) => (
                    <NoticeCard tone="danger" icon="ti ti-alert-circle" role="alert">
                      {domainError(t, (error() as Error & { code?: string }).code)}
                    </NoticeCard>
                  )}
                </Show>
              </div>
            </PanelDialog.Body>
            <PanelDialog.Footer>
              <Button variant="secondary" disabled={remove.loading()} onClick={() => close()}>
                {t.cancel}
              </Button>
              <Button variant="danger" loading={remove.loading()} onClick={() => void remove.mutate()}>
                {remove.loading() ? t.removing : remove.error() ? t.retry : t.removeConfirm}
              </Button>
            </PanelDialog.Footer>
          </div>
        </PanelDialog>
      );
    },
    { ...panelDialogOptions, role: "alertdialog", ariaLabel: domainsMessages.resolve([locale]).t.removeTitle({ host }) },
  );
