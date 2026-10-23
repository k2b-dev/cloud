import { PrincipalPicker } from "@k2b/cloud/access/ui";
import { coreClient } from "@k2b/cloud/clients/core";
import type { Principal } from "@k2b/cloud/contracts";
import { principalLabel } from "@k2b/cloud/shared";
import { mutation, query } from "@k2b/stdlib/solid";
import {
  Button,
  Combobox,
  dialogCore,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  RemoveButton,
  Tag,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { useAccountsMessages } from "../messages";
import { directoryMessages } from "./directory-messages";

const api = coreClient.admin.identity["directory-shares"];
type ExactPrincipal = Exclude<Principal, { type: "authenticated" } | { type: "public" }>;

export function DirectorySharesDialog(props: { close: () => void; setDismissHandler: (handler: () => void) => void }) {
  const locale = useLocale();
  const accountsText = useAccountsMessages();
  const t = () => directoryMessages.resolve([locale()]).t;
  const [recipient, setRecipient] = createSignal<{ id: string; label: string; description?: string } | null>(null);
  const [page, setPage] = createSignal(1);
  const [changedRecipient, setChangedRecipient] = createSignal<string>();
  const entries = query.create({
    source: () => ({ recipientId: recipient()?.id, page: page() }),
    load: async (source, { abortSignal }) => {
      if (!source.recipientId) return null;
      const response = await api[":recipientId"].$get(
        { param: { recipientId: source.recipientId }, query: { page: String(source.page), per_page: "20" } },
        { init: { signal: abortSignal } },
      );
      const result = await response.json();
      if (!response.ok || !("items" in result)) throw new Error(t().loadFailed);
      return result;
    },
  });
  const change = mutation.create({
    mutation: async (input: { recipientId: string; principal: ExactPrincipal } | { recipientId: string; id: string }, { abortSignal }) => {
      setChangedRecipient(input.recipientId);
      const response =
        "principal" in input
          ? await api[":recipientId"].$post(
              { param: { recipientId: input.recipientId }, json: { principal: input.principal } },
              { init: { signal: abortSignal } },
            )
          : await api[":recipientId"][":id"].$delete(
              { param: { recipientId: input.recipientId, id: input.id } },
              { init: { signal: abortSignal } },
            );
      if (!response.ok) throw new Error(t().failed);
    },
    onSuccess: () => {
      entries.refresh();
    },
  });
  props.setDismissHandler(() => {
    if (!change.loading()) props.close();
  });
  const blocked = () => change.loading() || entries.loading() || entries.refreshing() || Boolean(entries.error());
  return (
    <PanelDialog>
      <PanelDialog.Header title={t().title} icon="ti ti-address-book" close={change.loading() ? undefined : props.close} />
      <PanelDialog.Body>
        <div class="flex flex-col gap-4">
          <p class="text-sm text-dimmed">{t().hint}</p>
          <div class="flex flex-col gap-2">
            <span class="text-sm font-medium">{t().machine}</span>
            <Combobox
              placeholder={t().choose}
              disabled={change.loading()}
              fetchData={async (search, signal) => {
                const response = await coreClient.admin.identity["service-accounts"].$get(
                  { query: { search, status: "active", perPage: "20" } },
                  { init: { signal } },
                );
                const result = await response.json();
                if (!response.ok || !("items" in result)) throw new Error(t().loadFailed);
                return result.items.map((account) => ({
                  id: account.id,
                  label: account.name,
                  icon: account.kind === "agent" ? "ti ti-robot" : "ti ti-key",
                  description: account.kind === "agent" ? t().agent : t().service,
                }));
              }}
              onSelect={(option) => {
                setRecipient({ id: option.id, label: option.label, description: option.description });
                setPage(1);
              }}
            />
            <Show when={recipient()}>
              {(selected) => (
                <p class="flex items-center gap-2 text-sm font-medium">
                  {selected().label}
                  <Tag size="sm">{selected().description}</Tag>
                </p>
              )}
            </Show>
          </div>
          <Show when={recipient()}>
            <Show when={entries.error()}>
              {(error) => (
                <NoticeCard tone="danger" title={error().message}>
                  <Button onClick={() => entries.refresh()}>{t().retry}</Button>
                </NoticeCard>
              )}
            </Show>
            <Show when={changedRecipient() === recipient()?.id && change.error()}>
              {(error) => (
                <NoticeCard tone="danger" title={error().message}>
                  <Button disabled={change.loading()} onClick={() => change.retry()}>
                    {t().retry}
                  </Button>
                </NoticeCard>
              )}
            </Show>
            <h2 class="text-sm font-medium">{t().entries}</h2>
            <Show when={change.loading()}>
              <Placeholder state="loading" title={t().loading} />
            </Show>
            <PrincipalPicker
              allowAuthenticated={false}
              allowPublic={false}
              allowServiceAccounts
              disabled={blocked()}
              onSelect={(principal) => {
                const selected = recipient();
                if (selected && principal.type !== "authenticated" && principal.type !== "public")
                  void change.mutate({ recipientId: selected.id, principal });
              }}
            />
            <Show when={!entries.loading() && !entries.refreshing()} fallback={<Placeholder state="loading" title={t().loading} />}>
              <Show when={entries.data()?.items.length} fallback={<p class="text-sm text-dimmed">{entries.error() ? "" : t().empty}</p>}>
                <ul class="divide-y divide-border">
                  <For each={entries.data()?.items}>
                    {(entry) => (
                      <li class="flex items-center justify-between gap-3 py-2">
                        <span class="min-w-0 break-words text-sm">
                          {principalLabel({ principal: entry.principal, displayName: entry.label }, locale())}
                        </span>
                        <Show when={entry.principal.type === "service_account"}>
                          <Tag size="sm">
                            {entry.serviceAccountKind === "agent"
                              ? accountsText().agentServiceAccount
                              : entry.serviceAccountKind === "resource_bound"
                                ? accountsText().resourceBoundServiceAccount
                                : entry.serviceAccountKind === "user_delegated"
                                  ? accountsText().userBoundServiceAccount
                                  : accountsText().standaloneServiceAccount}
                          </Tag>
                        </Show>
                        <RemoveButton
                          ariaLabel={`${t().revoke}: ${entry.label}`}
                          disabled={blocked()}
                          onClick={() => {
                            const selected = recipient();
                            if (selected) void change.mutate({ recipientId: selected.id, id: entry.id });
                          }}
                        />
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </Show>
            <Show when={(entries.data()?.total ?? 0) > 20 || page() > 1}>
              <div class="flex justify-between gap-2">
                <Button variant="secondary" size="sm" disabled={blocked() || page() === 1} onClick={() => setPage((value) => value - 1)}>
                  {t().previous}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={blocked() || page() * 20 >= (entries.data()?.total ?? 0)}
                  onClick={() => setPage((value) => value + 1)}
                >
                  {t().next}
                </Button>
              </div>
            </Show>
          </Show>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button variant="secondary" disabled={change.loading()} onClick={props.close}>
          {t().close}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export default function DirectoryShares() {
  const locale = useLocale();
  const t = () => directoryMessages.resolve([locale()]).t;
  return (
    <Button
      variant="secondary"
      onClick={() =>
        void dialogCore.open<void>(
          (close, context) => <DirectorySharesDialog close={() => close()} setDismissHandler={context.setDismissHandler} />,
          panelDialogOptions,
        )
      }
    >
      {t().title}
    </Button>
  );
}
