import { coreClient } from "@k2b/cloud/clients/core";
import { formatDate } from "@k2b/cloud/shared";
import { dates } from "@k2b/stdlib";
import { copyToClipboard } from "@k2b/stdlib/browser";
import { mutation, query } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Dialog, Failed, List, Loading, Menu, Notice, Row, Section, Text, useToast } from "@k2b/ui/v2";
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import StateWord from "../_area/StateWord";
import { groupFingerprint, type KeyEntry, TokenDialog } from "./keys-dialogs";
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
/** Core's last refusal of a start with a verified proof, as the keys API reports it. */
export type StartRejection = {
  at: string;
  reason: "revoked" | "expired" | "disabled" | "connections_not_permitted";
  keyId: string | null;
};
type KeyList = { items: KeyEntry[]; lastRejectedStart: StartRejection | null };

export type KeysProps = {
  app: { id: string; name: string };
  neverStarted: boolean;
  /** Null when the server could not read the keys; the view then offers to try again. */
  initialKeys: KeyEntry[] | null;
  initialRejection: StartRejection | null;
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
 * The keys of one app: active and expired keys, the revoked ones behind a toggle, the menu of each key, and the
 * tokens of today's host operation collapsed below. SSR provides the first state; every change reads the list again.
 */
export default function Keys(props: KeysProps) {
  const locale = useLocale();
  const t = () => keysMessages.resolve([locale()]).t;
  const toast = useToast();
  const context = () => ({ locale: locale(), timeZone: props.timeZone });
  // Without a valid key, or when Core refused a start with a revoked one, the revoked ones explain why and open.
  const explainsRevoked = (data: KeyList | undefined) => {
    if (!data?.items.length) return false;
    const refused = data.lastRejectedStart?.keyId;
    return (
      !data.items.some((key) => key.status === "active") || data.items.some((key) => key.status === "revoked" && key.keyId === refused)
    );
  };
  const [showRevoked, setShowRevoked] = createSignal(
    explainsRevoked(props.initialKeys ? { items: props.initialKeys, lastRejectedStart: props.initialRejection } : undefined),
  );
  const [showTokens, setShowTokens] = createSignal(false);
  const [tokenPage, setTokenPage] = createSignal(1);
  const [tokenRevision, setTokenRevision] = createSignal(0);
  const [accountStatus, setAccountStatus] = createSignal(props.accountStatus);

  const keys = query.create({
    source: () => ({ revision: keysState.revision() }),
    initial: props.initialKeys
      ? { source: { revision: 0 }, data: { items: props.initialKeys, lastRejectedStart: props.initialRejection } }
      : undefined,
    isSameSource: (a, b) => a.revision === b.revision,
    load: async (_, { abortSignal }): Promise<KeyList> => {
      const response = await keysApi[":appId"].keys.$get(
        { param: { appId: props.app.id }, query: { page: "1", perPage: "100" } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(t().loadFailed);
      const body = (await response.json()) as KeyList;
      return { items: body.items, lastRejectedStart: body.lastRejectedStart };
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

  const list = () => keys.data()?.items ?? [];
  const rejection = () => keys.data()?.lastRejectedStart ?? null;
  const current = () => list().filter((key) => key.status !== "revoked");
  const revoked = () => list().filter((key) => key.status === "revoked");
  const active = () => list().filter((key) => key.status === "active");
  /** During a rotation the older active key is the one to retire. */
  // A later read (after a failed first one, or a new refusal) opens them too; closing by hand stays until that changes.
  createEffect(
    on(
      () => explainsRevoked(keys.data()),
      (open) => {
        if (open) setShowRevoked(true);
      },
      { defer: true },
    ),
  );
  const oldKeyId = () =>
    active().length >= 2 ? active().toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0]!.keyId : null;
  createEffect(
    on(
      () => keys.data()?.items,
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
      toast(t().copied, { status: "ok" });
    } catch {
      toast(t().copyFailed, { status: "bad" });
    }
  };
  /** A refused or unclear revocation, shown above the keys. */
  const [revokeProblem, setRevokeProblem] = createSignal<{ unclear: boolean } | null>(null);
  const revoke = async (key: KeyEntry) => {
    const last = active().length === 1 && key.status === "active";
    // k2b-ui gap: a destructive question asks with a red button once #4275 lands (danger: true).
    const asked = await Dialog.confirm({
      title: t().revokeTitle({ name: key.name }),
      description: `${t().revokeText({ app: props.app.name })}${last ? ` ${t().lastKeyLead} ${t().lastKeyText({ app: props.app.name })}` : ""}`,
      confirm: t().revokeAction,
    });
    if (!asked) return;
    setRevokeProblem(null);
    const response = await keysApi[":appId"].keys[":keyId"].$delete({ param: { appId: props.app.id, keyId: key.keyId } }).catch(() => null);
    // A lost answer may hide a revocation that happened: read the list again and let a second try repeat it safely.
    if (!response) setRevokeProblem({ unclear: true });
    else if (!response.ok) setRevokeProblem({ unclear: false });
    keysState.setRevision((value) => value + 1);
  };
  const [creatingToken, setCreatingToken] = createSignal(false);
  const [tokenProblem, setTokenProblem] = createSignal<string | null>(null);
  const revokeToken = async (token: TokenEntry) => {
    // k2b-ui gap: a destructive question asks with a red button once #4275 lands (danger: true).
    const asked = await Dialog.confirm({
      title: t().revokeTitle({ name: token.name }),
      description: `${token.tokenPrefix} · ${t().tokenRevokeConfirm}`,
      confirm: t().revokeAction,
    });
    if (!asked) return;
    setTokenProblem(null);
    const response = await workloads[":appId"].credentials[":credentialId"]
      .$delete({ param: { appId: props.app.id, credentialId: token.id } })
      .catch(() => null);
    if (!response?.ok) setTokenProblem(t().tokenFailed);
    refreshAfterToken();
  };
  /** The refused start on the key Core refused, so the list shows which key to replace. */
  const refused = (key: KeyEntry) => {
    const refusal = rejection();
    if (!refusal || refusal.keyId !== key.keyId) return null;
    const when = dates.formatTimeSpan(refusal.at, context());
    return refusal.reason === "connections_not_permitted" ? t().startRejectedNoConnections({ when }) : t().startRejected({ when });
  };
  const meta = (key: KeyEntry) => {
    const created = t().created({ date: formatDate(key.createdAt, context()) });
    if (key.status === "revoked")
      return [created, key.revokedAt ? t().revokedAt({ date: formatDate(key.revokedAt, context()) }) : null, refused(key)];
    return [
      created,
      key.createdBy ? props.people[key.createdBy] : null,
      key.status === "expired" && key.expiresAt
        ? t().expiredAt({ date: formatDate(key.expiresAt, context()) })
        : key.lastUsedAt
          ? t().usedAt({ when: dates.formatTimeSpan(key.lastUsedAt, context()) })
          : t().neverUsed,
      refused(key),
    ];
  };
  const stateChip = (status: "active" | "expired" | "revoked") =>
    // an active key is the good state: quiet words; expired and revoked are quiet too, only their words differ
    status === "active" ? (
      <StateWord>{t().active}</StateWord>
    ) : (
      <StateWord muted>{status === "expired" ? t().expired : t().revoked}</StateWord>
    );
  const KeyRow = (row: { key: KeyEntry }) => (
    <Row
      icon={row.key.status === "revoked" ? "key-off" : "key"}
      lines={[
        `${row.key.name}${row.key.keyId === oldKeyId() ? ` ${t().oldKey}` : ""}`,
        groupFingerprint(row.key.fingerprint),
        meta(row.key).filter(Boolean).join(" · "),
      ]}
      marks={stateChip(row.key.status)}
      end={
        <Show when={row.key.status !== "revoked"}>
          <Menu
            label={t().actionsFor({ name: row.key.name })}
            items={[
              { icon: "copy", label: t().copyFingerprint, onClick: () => void copy(groupFingerprint(row.key.fingerprint)) },
              { icon: "file-code", label: t().copyPublicKey, onClick: () => void copy(row.key.publicKey) },
              { icon: "key-off", label: t().revoke, danger: true, onClick: () => void revoke(row.key) },
            ]}
          />
        </Show>
      }
    />
  );
  /** Shows or hides a group. k2b-ui gap: v2 has no disclosure yet (#4191); a text button that names its count stands in. */
  const Toggle = (toggle: { open: boolean; label: string; onToggle: () => void }) => (
    <Bar
      start={
        <Button variant="text" icon={toggle.open ? "chevron-up" : "chevron-down"} onClick={toggle.onToggle}>
          {toggle.label}
        </Button>
      }
    />
  );
  return (
    <>
      <Show when={accountStatus() === "disabled"}>
        <Notice
          tone="bad"
          icon="player-pause"
          title={t().backgroundOffLead}
          actions={[{ label: t().backgroundOn, disabled: enable.loading(), onClick: () => void enable.mutate() }]}
        >
          {enable.error() ? t().backgroundFailed : t().backgroundOffText({ name: props.app.name })}
        </Notice>
      </Show>
      <Show when={keysState.support() === "insecure" || keysState.support() === "no-ed25519"}>
        <Notice
          tone="note"
          icon="terminal-2"
          title={keysState.support() === "insecure" ? t().noHttps : t().noEd25519}
          actions={props.docsHref ? [{ label: t().withoutCli, href: props.docsHref }] : undefined}
        >
          {`${t().withCli} cld admin apps keys create ${props.app.id} --out-dir ./secrets`}
        </Notice>
      </Show>
      <Show when={revokeProblem()}>
        {(problem) => (
          <Notice tone={problem().unclear ? "warn" : "bad"} title={problem().unclear ? t().unclearLead : t().revokeFailedLead}>
            {problem().unclear ? t().revokeUnclearText : t().revokeFailedText}
          </Notice>
        )}
      </Show>
      <Show when={!keys.error()} fallback={<Failed text={t().loadFailed} onRetry={() => void keys.refresh()} />}>
        <Show when={keys.data()} fallback={<Loading rows={2} lines={3} />}>
          <Show when={active().length >= 2}>
            <Notice tone="note" icon="refresh">
              {t().rotation}
            </Notice>
          </Show>
          <Show when={active().length === 0 && list().length > 0}>
            <Text muted>{t().noneActive}</Text>
          </Show>
          <Show
            when={current().length > 0}
            fallback={
              <Show when={list().length === 0}>
                <Text muted>{props.neverStarted ? t().emptyNew : t().emptyEnv({ name: props.app.name })}</Text>
              </Show>
            }
          >
            <List label={t().active}>
              <For each={current()}>{(key) => <KeyRow key={key} />}</For>
            </List>
          </Show>
          <Show when={revoked().length > 0}>
            <Toggle
              open={showRevoked()}
              label={t().revokedList({ count: revoked().length })}
              onToggle={() => setShowRevoked((open) => !open)}
            />
            <Show when={showRevoked()}>
              <List label={t().revoked}>
                <For each={revoked()}>{(key) => <KeyRow key={key} />}</For>
              </List>
            </Show>
          </Show>
        </Show>
      </Show>
      <Toggle
        open={showTokens()}
        label={t().tokens({ count: tokens.data()?.total ?? 0 })}
        onToggle={() => setShowTokens((open) => !open)}
      />
      <Show when={showTokens()}>
        <Section
          title={t().tokensTitle}
          summary={t().tokensText}
          actions={[{ label: t().tokenCreate, icon: "plus", onClick: () => setCreatingToken(true) }]}
        >
          <Show when={tokenProblem()}>{(problem) => <Notice tone="bad">{problem()}</Notice>}</Show>
          <Show when={!tokens.error()} fallback={<Failed text={t().tokensFailed} onRetry={() => void tokens.refresh()} />}>
            <Show when={(tokens.data()?.items.length ?? 0) > 0} fallback={<Text muted>{t().noTokens}</Text>}>
              <List label={t().tokensTitle}>
                <For each={tokens.data()?.items ?? []}>
                  {(token) => (
                    <Row
                      icon="certificate"
                      lines={[
                        token.name,
                        [
                          token.tokenPrefix,
                          token.expiresAt ? t().tokenExpires({ date: formatDate(token.expiresAt, context()) }) : t().tokenNoExpiry,
                          token.lastUsedAt ? t().usedAt({ when: dates.formatTimeSpan(token.lastUsedAt, context()) }) : t().neverUsed,
                        ].join(" · "),
                      ]}
                      marks={stateChip(tokenStatus(token))}
                      end={
                        <Show when={token.status !== "revoked"}>
                          <Menu
                            label={t().actionsFor({ name: token.name })}
                            items={[{ icon: "key-off", label: t().revoke, danger: true, onClick: () => void revokeToken(token) }]}
                          />
                        </Show>
                      }
                    />
                  )}
                </For>
              </List>
            </Show>
            <Show when={(tokens.data()?.total ?? 0) > PER_PAGE}>
              <Bar
                start={
                  <>
                    <Button disabled={tokenPage() <= 1 || tokens.loading()} onClick={() => setTokenPage((page) => page - 1)}>
                      {t().previous}
                    </Button>
                    <Button disabled={!tokens.data()?.hasNext || tokens.loading()} onClick={() => setTokenPage((page) => page + 1)}>
                      {t().next}
                    </Button>
                  </>
                }
              />
            </Show>
          </Show>
        </Section>
      </Show>
      <TokenDialog
        app={props.app}
        t={t()}
        open={creatingToken()}
        onClose={() => setCreatingToken(false)}
        onChanged={() => setTokenRevision((value) => value + 1)}
      />
    </>
  );
}
