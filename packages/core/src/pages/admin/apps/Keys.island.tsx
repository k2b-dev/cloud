import { coreClient } from "@k2b/cloud/clients/core";
import { formatDate } from "@k2b/cloud/shared";
import { dates } from "@k2b/stdlib";
import { copyToClipboard } from "@k2b/stdlib/browser";
import { mutation, query } from "@k2b/stdlib/solid";
import { Button, Dropdown, NoticeCard, Skeleton, StatusBadge, toast, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { groupFingerprint, type KeyEntry, openRevokeKeyDialog, openTokenDialog } from "./keys-dialogs";
import { keysMessages } from "./keys-messages";
import { keysState } from "./keys-state";

export type TokenEntry = {
  id: string;
  name: string;
  tokenPrefix: string;
  status: "active" | "revoked";
  expiresAt: string | null;
  lastUsedAt: string | null;
};
const tokenStatus = (token: TokenEntry) =>
  token.status === "revoked" ? "revoked" : token.expiresAt && Date.parse(token.expiresAt) <= Date.now() ? "expired" : "active";
type Tokens = { items: TokenEntry[]; total: number; hasNext: boolean };

export type KeysProps = {
  app: { id: string; name: string };
  neverStarted: boolean;
  /** Null when the server could not read the keys; the column then offers to try again. */
  initialKeys: KeyEntry[] | null;
  /** Display names of the people who created keys, by user ID. */
  people: Record<string, string>;
  /** "disabled" means background access is off for the whole app. */
  accountStatus: "active" | "disabled" | null;
  tokens: Tokens | null;
  /** Fibel page on app keys, for the sentence and the openssl way. */
  docsHref: string | null;
  timeZone: string;
};

const PER_PAGE = 20;
const keysApi = coreClient.admin.apps;
const workloads = coreClient.admin.identity.workloads;

/**
 * The keys of one app: active and expired keys, the revoked ones behind a disclosure, the menu of each key, and the
 * tokens of today's host operation collapsed below. SSR provides the first state; every change reads the list again.
 */
export default function Keys(props: KeysProps) {
  const locale = useLocale();
  const t = () => keysMessages.resolve([locale()]).t;
  const context = () => ({ locale: locale(), timeZone: props.timeZone });
  // Without a valid key, the revoked and expired ones explain why; revoked ones start open.
  const [showRevoked, setShowRevoked] = createSignal(
    Boolean(props.initialKeys?.length) && !(props.initialKeys ?? []).some((key) => key.status === "active"),
  );
  const [showTokens, setShowTokens] = createSignal(false);
  const [tokenPage, setTokenPage] = createSignal(1);
  const [tokenRevision, setTokenRevision] = createSignal(0);
  const [accountStatus, setAccountStatus] = createSignal(props.accountStatus);

  const keys = query.create({
    source: () => ({ revision: keysState.revision() }),
    initial: props.initialKeys ? { source: { revision: 0 }, data: props.initialKeys } : undefined,
    isSameSource: (a, b) => a.revision === b.revision,
    load: async (_, { abortSignal }): Promise<KeyEntry[]> => {
      const response = await keysApi[":appId"].keys.$get(
        { param: { appId: props.app.id }, query: { page: "1", perPage: "100" } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(t().loadFailed);
      return ((await response.json()) as { items: KeyEntry[] }).items;
    },
  });
  const tokens = query.create({
    source: () => ({ page: tokenPage(), revision: tokenRevision() }),
    initial: props.tokens ? { source: { page: 1, revision: 0 }, data: props.tokens } : undefined,
    isSameSource: (a, b) => a.page === b.page && a.revision === b.revision,
    load: async (source, { abortSignal }): Promise<Tokens> => {
      const response = await workloads[":appId"].credentials.$get(
        { param: { appId: props.app.id }, query: { page: String(source.page), perPage: String(PER_PAGE) } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(t().tokensFailed);
      const body = (await response.json()) as Tokens;
      return { items: body.items, total: body.total, hasNext: body.hasNext };
    },
  });
  const refreshAfterToken = () => {
    setTokenRevision((value) => value + 1);
    keysState.setRevision((value) => value + 1);
  };
  const enable = mutation.create({
    mutation: async (_: void, { abortSignal }) => {
      const response = await workloads[":appId"].$patch(
        { param: { appId: props.app.id }, json: { status: "active" } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(t().backgroundFailed);
    },
    onSuccess: () => {
      setAccountStatus("active");
      keysState.setDisabledAccount(false);
      setTokenRevision((value) => value + 1);
    },
  });
  onCleanup(() => enable.abort());

  const list = () => keys.data() ?? [];
  const current = () => list().filter((key) => key.status !== "revoked");
  const revoked = () => list().filter((key) => key.status === "revoked");
  const active = () => list().filter((key) => key.status === "active");
  /** During a rotation the older active key is the one to retire. */
  const oldKeyId = () =>
    active().length >= 2 ? active().toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0]!.keyId : null;
  createEffect(
    on(
      () => keys.data(),
      (data) => {
        if (!data) return;
        keysState.setActiveCount(data.filter((key) => key.status === "active").length);
        // Revoking an automatic runtime token turns background access off; the keys read again says so.
        const status = data[0]?.accountStatus;
        if (status) {
          setAccountStatus(status);
          keysState.setDisabledAccount(status === "disabled");
        }
      },
    ),
  );

  const copy = async (text: string) => {
    try {
      await copyToClipboard(text);
      toast.success(t().copied);
    } catch {
      toast.error(t().copyFailed);
    }
  };
  const meta = (key: KeyEntry) => {
    const created = t().created({ date: formatDate(key.createdAt, context()) });
    if (key.status === "revoked") return [created, key.revokedAt ? t().revokedAt({ date: formatDate(key.revokedAt, context()) }) : null];
    return [
      created,
      key.createdBy ? props.people[key.createdBy] : null,
      key.status === "expired" && key.expiresAt
        ? t().expiredAt({ date: formatDate(key.expiresAt, context()) })
        : key.lastUsedAt
          ? t().usedAt({ when: dates.formatTimeSpan(key.lastUsedAt, context()) })
          : t().neverUsed,
    ];
  };
  const Row = (row: { key: KeyEntry }) => (
    <div
      class="grid min-h-[76px] grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 rounded-lg px-2.5 py-2.5 hover:bg-(--k2b-hover)"
      data-key={row.key.name}
    >
      <div class="min-w-0">
        <div class="flex min-w-0 items-center gap-2 text-sm font-medium" classList={{ "text-dimmed": row.key.status === "revoked" }}>
          <span class="truncate">
            {row.key.name}
            {row.key.keyId === oldKeyId() ? ` ${t().oldKey}` : ""}
          </span>
          <StatusBadge
            icon={null}
            tone={row.key.status === "active" ? "ok" : "neutral"}
            label={row.key.status === "active" ? t().active : row.key.status === "expired" ? t().expired : t().revoked}
          />
        </div>
        <div class="mt-0.5 font-mono text-[12.5px] tracking-wide text-secondary">{groupFingerprint(row.key.fingerprint)}</div>
        <div class="mt-0.5 text-[12.5px] text-dimmed">{meta(row.key).filter(Boolean).join(" · ")}</div>
      </div>
      <Show when={row.key.status !== "revoked"}>
        <Dropdown.Root
          position="bottom-right"
          phone="sheet"
          label={t().actionsFor({ name: row.key.name })}
          items={[
            {
              icon: "ti ti-copy",
              label: t().copyFingerprint,
              action: () => void copy(groupFingerprint(row.key.fingerprint)),
              immediate: true,
            },
            { icon: "ti ti-file-code", label: t().copyPublicKey, action: () => void copy(row.key.publicKey), immediate: true },
            {
              icon: "ti ti-key-off",
              label: t().revoke,
              variant: "danger",
              action: () =>
                void openRevokeKeyDialog(props.app, row.key, active().length === 1 && row.key.status === "active", locale(), () =>
                  keysState.setRevision((value) => value + 1),
                ),
            },
          ]}
        >
          <Dropdown.Trigger iconOnly label={t().actionsFor({ name: row.key.name })} size="xs" variant="ghost">
            <i class="ti ti-dots" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      </Show>
    </div>
  );
  const Disclose = (disclose: { open: boolean; label: string; toggle: () => void }) => (
    <button
      type="button"
      class="mt-1 flex w-full items-center gap-1.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-dimmed hover:bg-(--k2b-hover)"
      aria-expanded={disclose.open}
      onClick={disclose.toggle}
    >
      <i class={`ti ${disclose.open ? "ti-chevron-up" : "ti-chevron-down"}`} aria-hidden="true" />
      {disclose.label}
    </button>
  );
  const fallback = (reason: string) => (
    <NoticeCard tone="neutral" icon="ti ti-terminal-2" class="mb-2">
      <span>
        <b>{reason}</b> {t().withCli}
      </span>
      <code class="mt-1.5 block font-mono">{`cld admin apps keys create ${props.app.id} --out-dir ./secrets`}</code>
      <Show when={props.docsHref}>
        {(href) => (
          <a class="mt-1.5 inline-block underline underline-offset-3" href={href()}>
            {t().withoutCli}
          </a>
        )}
      </Show>
    </NoticeCard>
  );
  return (
    <div class="flex flex-col" data-keys={props.app.id}>
      <Show when={accountStatus() === "disabled"}>
        <NoticeCard tone="danger" icon="ti ti-player-pause" class="mb-2" data-background-off>
          <span>
            <b>{t().backgroundOffLead}</b> {t().backgroundOffText({ name: props.app.name })}
          </span>
          <span class="mt-1.5 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" loading={enable.loading()} onClick={() => void enable.mutate()}>
              {t().backgroundOn}
            </Button>
            <Show when={enable.error()}>{(error) => <span>{error().message}</span>}</Show>
          </span>
        </NoticeCard>
      </Show>
      <Show when={keysState.support() === "insecure"}>{fallback(t().noHttps)}</Show>
      <Show when={keysState.support() === "no-ed25519"}>{fallback(t().noEd25519)}</Show>
      <Show
        when={!keys.error()}
        fallback={
          <div class="flex flex-col items-start gap-2 px-2.5 py-2 text-[13.5px] text-secondary">
            <span>
              <i class="ti ti-alert-triangle text-(--k2b-danger-text)" aria-hidden="true" /> {t().loadFailed}
            </span>
            <Button size="sm" variant="secondary" loading={keys.refreshing()} onClick={() => void keys.refresh()}>
              <i class="ti ti-refresh" aria-hidden="true" />
              {t().retry}
            </Button>
          </div>
        }
      >
        <Show
          when={keys.data()}
          fallback={
            <div role="status" aria-label={t().loading} class="flex flex-col gap-0.5">
              <Skeleton class="h-[76px] rounded-lg" />
              <Skeleton class="h-[76px] w-3/4 rounded-lg" />
            </div>
          }
        >
          <Show when={active().length >= 2}>
            <p class="mx-2.5 mb-2 flex items-baseline gap-1.5 text-[13px] text-dimmed">
              <i class="ti ti-refresh" aria-hidden="true" />
              {t().rotation}
            </p>
          </Show>
          <Show when={active().length === 0 && list().length > 0}>
            <p class="mx-2.5 my-1 text-[13.5px] text-dimmed">{t().noneActive}</p>
          </Show>
          <Show
            when={current().length > 0}
            fallback={
              <Show when={list().length === 0}>
                <p class="mx-2.5 my-1 text-[13.5px] text-dimmed">
                  {props.neverStarted ? t().emptyNew : t().emptyEnv({ name: props.app.name })}
                </p>
              </Show>
            }
          >
            <div class="flex flex-col gap-0.5">
              <For each={current()}>{(key) => <Row key={key} />}</For>
            </div>
          </Show>
          <Show when={revoked().length > 0}>
            <Disclose
              open={showRevoked()}
              label={t().revokedList({ count: revoked().length })}
              toggle={() => setShowRevoked((open) => !open)}
            />
            <Show when={showRevoked()}>
              <div class="flex flex-col gap-0.5">
                <For each={revoked()}>{(key) => <Row key={key} />}</For>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
      <div class="mt-3">
        <Disclose
          open={showTokens()}
          label={t().tokens({ count: tokens.data()?.total ?? 0 })}
          toggle={() => setShowTokens((open) => !open)}
        />
        <Show when={showTokens()}>
          <p class="mx-2.5 mt-1 mb-2 max-w-[40rem] text-[13.5px] text-dimmed">{t().tokensText}</p>
          <Show
            when={!tokens.error()}
            fallback={
              <div class="flex flex-col items-start gap-2 px-2.5 text-[13.5px] text-secondary">
                {t().tokensFailed}
                <Button size="sm" variant="secondary" onClick={() => void tokens.refresh()}>
                  {t().retry}
                </Button>
              </div>
            }
          >
            <div class="flex flex-col gap-0.5">
              <For each={tokens.data()?.items ?? []} fallback={<p class="mx-2.5 text-[13.5px] text-dimmed">{t().noTokens}</p>}>
                {(token) => (
                  <div
                    class="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 rounded-lg px-2.5 py-2.5 hover:bg-(--k2b-hover)"
                    data-token={token.name}
                  >
                    <div class="min-w-0">
                      <div class="flex min-w-0 items-center gap-2 text-sm font-medium">
                        <span class="truncate">{token.name}</span>
                        <StatusBadge
                          icon={null}
                          tone={tokenStatus(token) === "active" ? "ok" : "neutral"}
                          label={{ active: t().active, expired: t().expired, revoked: t().revoked }[tokenStatus(token)]}
                        />
                      </div>
                      <div class="mt-0.5 text-[12.5px] text-dimmed">
                        {[
                          token.expiresAt ? t().tokenExpires({ date: formatDate(token.expiresAt, context()) }) : t().tokenNoExpiry,
                          token.lastUsedAt ? t().usedAt({ when: dates.formatTimeSpan(token.lastUsedAt, context()) }) : t().neverUsed,
                        ].join(" · ")}
                      </div>
                    </div>
                    <Show when={token.status !== "revoked"}>
                      <Dropdown.Root
                        position="bottom-right"
                        phone="sheet"
                        label={t().actionsFor({ name: token.name })}
                        items={[
                          {
                            icon: "ti ti-key-off",
                            label: t().revoke,
                            variant: "danger",
                            action: () =>
                              void openTokenDialog(props.app, locale(), refreshAfterToken, {
                                id: token.id,
                                name: token.name,
                                prefix: token.tokenPrefix,
                              }),
                          },
                        ]}
                      >
                        <Dropdown.Trigger iconOnly label={t().actionsFor({ name: token.name })} size="xs" variant="ghost">
                          <i class="ti ti-dots" aria-hidden="true" />
                        </Dropdown.Trigger>
                      </Dropdown.Root>
                    </Show>
                  </div>
                )}
              </For>
            </div>
            <div class="mx-2.5 mt-1 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void openTokenDialog(props.app, locale(), () => setTokenRevision((value) => value + 1))}
              >
                <i class="ti ti-plus" aria-hidden="true" />
                {t().tokenCreate}
              </Button>
              <Show when={(tokens.data()?.total ?? 0) > PER_PAGE}>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={tokenPage() <= 1 || tokens.loading()}
                  onClick={() => setTokenPage((page) => page - 1)}
                >
                  {t().previous}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!tokens.data()?.hasNext || tokens.loading()}
                  onClick={() => setTokenPage((page) => page + 1)}
                >
                  {t().next}
                </Button>
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
