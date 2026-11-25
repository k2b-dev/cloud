import { useLocale } from "@k2b/ui";
import {
  Avatar,
  Bar,
  Button,
  FilterBar,
  Inline,
  Input,
  ListOrder,
  Menu,
  Notice,
  Pane,
  StatusRow,
  Table,
  Text,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import AccountsNav from "../AccountsNav";
import { usePageSwap } from "../lib/page-swap";
import { useListMessages } from "../list-messages";
import { useAccountsMessages } from "../messages";
import type { ApiKeyRow } from "./api-key-row";
import {
  accessLabel,
  confirmRevoke,
  KeyDialog,
  kindLabel,
  ownerName,
  ReplaceKeyDialog,
  revokeCredential,
  statusChip,
} from "./credential-dialogs";
import DirectorySharesDialog from "./DirectorySharesDialog";
import { directoryMessages } from "./directory-messages";
import MachineKeyDialog from "./MachineKeyDialog";
import { useApiKeyMessages } from "./messages";
import { API_KEYS_PATH, type ApiKeysState, apiKeysHref, apiKeysQuery } from "./query";

export type ApiKeysScreenProps = {
  state: ApiKeysState;
  page: number;
  pages: number;
  /** Keys that match the address, automatic app keys left out unless it names them. */
  total: number;
  rows: ApiKeyRow[];
  /** Automatic app keys the address hides; null while it shows them. */
  hiddenAutomatic: number | null;
  modelsAvailable: boolean;
  timeZone: string;
  pendingRequests: number;
  /** Parameters of the address that did not apply, already worded. */
  ignored: string | null;
};

type Replacing = { name: string; serviceAccountId: string; credentialId: string };

/**
 * The API keys of this Cloud on v2: type, status and automatic app keys as statements, the search in the head, one row
 * per key. A row opens the key with its facts and deeds ("Replace", "Revoke"), on the phone too. Every change shows the
 * list again from the server, which filters it.
 */
export default function ApiKeysScreen(props: ApiKeysScreenProps) {
  const locale = useLocale();
  const t = useAccountsMessages();
  const words = useApiKeyMessages();
  const list = useListMessages();
  const toast = useToast();
  const { showChanges, openPage } = usePageSwap();
  const query = createMemo(() => apiKeysQuery(locale()));
  const [state, setState] = createSignal<ApiKeysState>(props.state);
  const [ignored, setIgnored] = createSignal(props.ignored);
  const [refreshing, setRefreshing] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const [opened, setOpened] = createSignal<ApiKeyRow | null>(null);
  const [replacing, setReplacing] = createSignal<Replacing | null>(null);
  const [sharing, setSharing] = createSignal(false);
  const changed = () => query().serialize(state()).toString() !== query().serialize(query().reset()).toString();
  const automaticShown = () => state().filters.automatic === "1";
  const legacy = () => props.rows.some((row) => row.access === "legacy" && row.active);

  /** Shows the list again from the server, with a quiet mark while it comes. */
  const refresh = async () => {
    setRefreshing(true);
    try {
      await showChanges();
    } finally {
      setRefreshing(false);
    }
  };
  /** The bar wrote the address; a new filter starts at page 1, and the server shows the list for it. */
  const change = (next: ApiKeysState) => {
    setState(next);
    const params = new URLSearchParams(location.search);
    if (params.has("page") && query().serialize(next).toString() !== query().serialize(props.state).toString()) {
      params.delete("page");
      history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`);
    }
    void refresh();
  };
  const search = (text: string) => {
    const next = query().set(state(), "q", text.trim());
    if (next) {
      setRefreshing(true);
      void openPage(apiKeysHref(query(), next));
    }
  };
  const automaticHref = () => {
    const next = automaticShown() ? query().clear(state(), "automatic") : (query().set(state(), "automatic", "1") ?? state());
    return apiKeysHref(query(), next);
  };

  const revoke = async (entry: ApiKeyRow) => {
    setOpened(null);
    if (!(await confirmRevoke(t(), words(), entry))) return;
    try {
      await revokeCredential(entry.id, t().revokeApiKeyFailed);
      toast(words().revoked_({ name: entry.name }), { status: "ok" });
      await refresh();
    } catch (failure) {
      toast(failure instanceof Error ? failure.message : t().revokeApiKeyFailed, { status: "bad" });
    }
  };
  const replace = (entry: ApiKeyRow, serviceAccountId: string) => {
    setOpened(null);
    setReplacing({ name: entry.name, serviceAccountId, credentialId: entry.id });
  };

  const owner = (row: ApiKeyRow) =>
    row.owner.kind === "user" ? (
      <Inline>
        <Avatar name={row.owner.name} image={row.owner.image} decorative />
        <Text href={row.owner.href}>{row.owner.name}</Text>
      </Inline>
    ) : row.owner.kind === "agent" ? (
      <Text href={row.owner.href}>{row.owner.name}</Text>
    ) : (
      ownerName(t(), row)
    );
  const ownerDetail = (row: ApiKeyRow) =>
    row.owner.kind === "user" ? row.owner.detail : row.owner.kind === "agent" ? t().agentServiceAccount : row.owner.detail;

  return (
    <Workspace
      sidebar={<AccountsNav active="api-keys" pendingRequests={props.pendingRequests} />}
      head={
        <Bar
          start={<Text type="body">{t().serviceAccounts}</Text>}
          end={
            <>
              <Input
                type="search"
                icon="search"
                label={t().searchServiceAccountsLabel}
                placeholder={t().searchServiceAccounts}
                value={state().search ?? ""}
                onKeyDown={(event) => {
                  if (event.isComposing) return;
                  const input = event.currentTarget as HTMLInputElement;
                  if (event.key === "Enter") search(input.value);
                  if (event.key === "Escape" && input.value) {
                    input.value = "";
                    search("");
                  }
                }}
              />
              <Menu
                label={words().more}
                items={[{ label: directoryMessages.resolve([locale()]).t.title, icon: "address-book", onClick: () => setSharing(true) }]}
              />
              <Button variant="primary" icon="key" onClick={() => setCreating(true)}>
                {t().createMachineKey}
              </Button>
            </>
          }
        />
      }
      primary={{ label: t().createMachineKey, icon: "key", onClick: () => setCreating(true) }}
    >
      <Show when={creating()}>
        <MachineKeyDialog
          modelsAvailable={props.modelsAvailable}
          timeZone={props.timeZone}
          close={(changedList) => {
            setCreating(false);
            if (changedList) void refresh();
          }}
        />
      </Show>
      <Show when={sharing()}>
        <DirectorySharesDialog close={() => setSharing(false)} />
      </Show>
      <KeyDialog entry={opened()} close={() => setOpened(null)} revoke={(entry) => void revoke(entry)} replace={replace} />
      <Show when={replacing()}>
        {(target) => (
          <ReplaceKeyDialog
            name={target().name}
            serviceAccountId={target().serviceAccountId}
            credentialId={target().credentialId}
            close={(changedList) => {
              setReplacing(null);
              if (changedList) void refresh();
            }}
          />
        )}
      </Show>
      <Pane
        label={t().serviceAccounts}
        scrollKey="accounts-api-keys"
        status={
          <>
            <FilterBar
              query={query()}
              state={state()}
              onChange={change}
              icons={{ kind: "user-key", status: "circle-dot", automatic: "refresh" }}
              results={t().serviceAccountSummary({ count: props.total })}
            />
            <StatusRow
              lead={t().serviceAccountSummary({ count: props.total })}
              loading={refreshing()}
              filters={<ListOrder query={query()} state={state()} onChange={change} />}
            />
          </>
        }
      >
        <Show when={ignored()}>
          {(text) => (
            <Notice tone="warn" title={list().ignoredParts} actions={[{ label: list().hide, onClick: () => setIgnored(null) }]}>
              {text()}
            </Notice>
          )}
        </Show>
        <Show when={automaticShown() || (props.hiddenAutomatic ?? 0) > 0}>
          <Notice
            tone="note"
            icon="refresh"
            actions={[{ label: automaticShown() ? t().hideAutomatic : t().showAutomatic, href: automaticHref() }]}
          >
            {automaticShown() ? t().automaticAppKeysShown : t().automaticAppKeysHidden({ count: props.hiddenAutomatic ?? 0 })}
          </Notice>
        </Show>
        <Show when={legacy()}>
          <Notice tone="note" icon="lock" title={t().legacyLimitedKey}>
            {t().legacyLimitedKeyHint}
          </Notice>
        </Show>
        <Table
          label={t().serviceAccounts}
          rows={props.rows}
          rowKey={(row) => row.id}
          sticky
          open={(row) => ({ onOpen: () => setOpened(row) })}
          empty={
            changed() || state().search
              ? {
                  icon: "filter-off",
                  text: words().noMatches,
                  action: { label: list().resetFilters, icon: "filter-off", href: API_KEYS_PATH },
                }
              : { icon: "key", text: words().noKeys }
          }
          phone={(row) => ({
            lines: [row.name, `${ownerName(t(), row)} · ${kindLabel(t(), row.kind)}`],
            time: row.lastUsed ?? undefined,
            marks: statusChip(t(), row),
          })}
          columns={[
            { title: t().apiKey, width: { min: 180, default: 220 }, cell: (row) => ({ lines: [row.name, row.prefix] }) },
            { title: t().owner, width: { min: 180, default: 240 }, cell: (row) => ({ lines: [owner(row), ownerDetail(row)] }) },
            {
              title: t().type,
              width: { min: 120, default: 150 },
              cell: (row) => ({ lines: [kindLabel(t(), row.kind), row.access ? accessLabel(t(), row.access) : ""] }),
              drop: true,
            },
            { title: t().status, width: { min: 100, default: 110 }, cell: (row) => statusChip(t(), row), drop: true },
            { title: t().expires, width: { min: 120, default: 150 }, cell: (row) => row.expires ?? words().never, drop: true },
            { title: t().lastUsed, width: { min: 120, default: 150 }, cell: (row) => row.lastUsed ?? words().neverUsed, drop: true },
            { title: t().created, width: { min: 120, default: 150 }, cell: (row) => row.created, drop: true },
          ]}
        />
        <Show when={props.pages > 1}>
          <Bar
            start={<Text type="meta">{list().pageOf({ page: props.page, pages: props.pages })}</Text>}
            end={
              <>
                <Button icon="chevron-left" href={apiKeysHref(query(), state(), props.page - 1)} disabled={props.page <= 1}>
                  {list().previous}
                </Button>
                <Button href={apiKeysHref(query(), state(), props.page + 1)} disabled={props.page >= props.pages} forward>
                  {list().next}
                </Button>
              </>
            }
          />
        </Show>
      </Pane>
    </Workspace>
  );
}
