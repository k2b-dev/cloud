import { coreClient } from "@k2b/cloud/clients/core";
import {
  Band,
  Bar,
  Button,
  Canvas,
  Chip,
  Choice,
  Facts,
  Failed,
  Field,
  Input,
  Notice,
  Pane,
  RecordHead,
  Section,
  StatusRow,
  Table,
  Text,
  Workspace,
} from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { z } from "zod";
import { usePageSwap } from "@/frontend/lib/page-swap";
import AccountsNav from "../AccountsNav";
import AgentPictureTrigger from "./AgentPictureTrigger";
import { AGENT_KEY_SORTS, type AgentKey, type AgentKeyOpen, type AgentKeySort, agentPageHref } from "./agent-keys";
import { type AgentMessages, useAgentMessages } from "./messages";

/** A key as the page shows it: dates come formatted from the server, so the first paint and the live page agree. */
export type AgentKeyView = Pick<AgentKey, "id" | "name" | "tokenPrefix" | "access"> & {
  created: string;
  lastUsed: string | null;
  expires: string | null;
  expired: boolean;
};

export type AgentView = {
  id: string;
  name: string;
  active: boolean;
  avatarHash: string | null;
  created: string;
  createdBy: { name: string; href: string } | null;
};

type Props = {
  agent: AgentView;
  /** The keys in the chosen order; null when they could not be loaded. */
  keys: readonly AgentKeyView[] | null;
  sort: AgentKeySort;
  open: AgentKeyOpen;
  modelsAvailable: boolean;
  pendingRequests: number;
};

const accessLabel = (t: AgentMessages, access: AgentKey["access"]) =>
  access === "models" ? t.modelsOnly : access === "legacy" ? t.legacyLimited : t.fullAccess;

const sortLabel = (t: AgentMessages, sort: AgentKeySort) => (sort === "name" ? t.sortName : sort === "used" ? t.sortUsed : t.sortCreated);

const ErrorSchema = z.object({ message: z.string() });
const CreatedSchema = z.object({ token: z.string().min(1) });

/** The form for a new key, then the key itself, once, with a copy button. Closing leaves the page without the token. */
function NewKey(props: { agent: AgentView; modelsAvailable: boolean; close: string }) {
  const t = useAgentMessages();
  const [name, setName] = createSignal("");
  const [access, setAccess] = createSignal<"full" | "models">("full");
  const [tried, setTried] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // A lost answer may follow a created key: offer no second creation, the list shows what exists.
  const [uncertain, setUncertain] = createSignal(false);
  const [token, setToken] = createSignal<string | null>(null);
  const nameError = () => (tried() && !name().trim() ? t().keyNameRequired : undefined);

  const create = async () => {
    setTried(true);
    if (busy() || uncertain() || !props.agent.active || !name().trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await coreClient.admin.identity["service-accounts"][":id"]["api-keys"]
        .$post({ param: { id: props.agent.id }, json: { name: name().trim(), access: access(), expiresAt: null } })
        .catch(() => null);
      const body: unknown = response ? await response.json().catch(() => null) : null;
      if (response && !response.ok && response.status < 500) {
        const parsed = ErrorSchema.safeParse(body);
        setError(parsed.success ? parsed.data.message : t().createFailed);
        return;
      }
      const created = CreatedSchema.safeParse(body);
      if (!response?.ok || !created.success) {
        setUncertain(true);
        setError(t().createUncertain);
        return;
      }
      setToken(created.data.token);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show
      when={token()}
      fallback={
        <>
          <Show when={!props.agent.active}>
            <Notice tone="warn" icon="alert-triangle">
              {t().agentDisabledNotice}
            </Notice>
          </Show>
          <Band>
            <Field name="name" label={t().keyName} hint={t().keyNameHint} error={nameError()} required>
              <Input
                value={name()}
                onInput={setName}
                ref={(element) => queueMicrotask(() => element.focus())}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.isComposing) void create();
                }}
              />
            </Field>
            <Show when={props.modelsAvailable}>
              <Field name="access" label={t().keyAccess} hint={access() === "models" ? t().modelsOnlyHint : t().fullAccessHint}>
                <Choice
                  name="access"
                  value={access()}
                  onChange={(value) => setAccess(value === "models" ? "models" : "full")}
                  options={[
                    { value: "full", label: t().fullAccess },
                    { value: "models", label: t().modelsOnly },
                  ]}
                />
              </Field>
            </Show>
          </Band>
          <Show when={error()}>
            {(message) => (
              <Notice tone="bad" icon="alert-circle">
                {message()}
              </Notice>
            )}
          </Show>
          <Bar
            end={
              <>
                <Button href={props.close}>{t().cancel}</Button>
                {/* k2b-ui gap: a v2 button has no busy state; the label says it and the button rests disabled */}
                <Button icon="key" onClick={() => void create()} disabled={busy() || uncertain() || !props.agent.active}>
                  {busy() ? t().creating : t().create}
                </Button>
              </>
            }
          />
        </>
      }
    >
      {(value) => (
        <>
          <Notice tone="warn" icon="key" title={t().created_}>
            {t().oneTime}
          </Notice>
          <Section title={name().trim()}>
            <Facts
              items={[
                { label: t().token, value: value(), copy: value() },
                { label: t().keyAccess, value: accessLabel(t(), access()) },
              ]}
            />
          </Section>
          <Bar end={<Button href={props.close}>{t().done}</Button>} />
        </>
      )}
    </Show>
  );
}

/** One key: its facts, and revoking it after a second, explicit step. */
function OpenKey(props: { agentId: string; entry: AgentKeyView; close: string }) {
  const t = useAgentMessages();
  const { openPage } = usePageSwap();
  const [confirming, setConfirming] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const revoke = async () => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await coreClient.admin.identity["service-accounts"][":id"]["api-keys"][":credentialId"]
        .$delete({ param: { id: props.agentId, credentialId: props.entry.id } })
        .catch(() => null);
      if (!response?.ok) {
        const parsed = ErrorSchema.safeParse(response ? await response.json().catch(() => null) : null);
        setError(parsed.success ? parsed.data.message : t().revokeFailed);
        return;
      }
      await openPage(props.close);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Section title={t().details}>
        <Facts
          items={[
            { label: t().prefix, value: `${props.entry.tokenPrefix}…` },
            { label: t().keyAccess, value: accessLabel(t(), props.entry.access) },
            { label: t().created, value: props.entry.created },
            { label: t().lastUsed, value: props.entry.lastUsed ?? t().neverUsed },
            {
              label: t().expires,
              value: props.entry.expired ? <Chip status="warn">{t().expired}</Chip> : (props.entry.expires ?? t().never),
            },
          ]}
        />
      </Section>
      <Show
        when={confirming()}
        fallback={
          <Bar
            end={
              <Button
                icon="key-off"
                onClick={() => {
                  setConfirming(true);
                  // the button leaves; the focus goes to the deed that confirms
                  queueMicrotask(() =>
                    document.querySelector<HTMLButtonElement>("[data-k2-part='Notice'][data-tone='bad'] button")?.focus(),
                  );
                }}
              >
                {t().revoke}
              </Button>
            }
          />
        }
      >
        <Notice
          tone="bad"
          icon="key-off"
          title={t().revokeTitle({ name: props.entry.name })}
          actions={[
            { label: busy() ? t().revoking : t().revoke, icon: "key-off", onClick: () => void revoke() },
            { label: t().cancel, onClick: () => setConfirming(false) },
          ]}
        >
          {t().revokeConsequence}
        </Notice>
      </Show>
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
    </>
  );
}

/**
 * An agent's page on v2: its name and picture, and its access: the API keys in the chosen order, each of which opens
 * beside the list. What is open (a new key, one key) and the order live in the address. A new key's token exists only
 * in this page's memory until the panel closes.
 */
export default function AgentScreen(props: Props) {
  const t = useAgentMessages();
  const { showChanges } = usePageSwap();
  const href = (open?: string) => agentPageHref(props.agent.id, { sort: props.sort, open });
  const status = () => (props.agent.active ? t().active : t().disabled);
  const openKey = () => {
    const open = props.open;
    return open.kind === "key" ? (props.keys?.find((entry) => entry.id === open.id) ?? null) : null;
  };
  const detailTitle = () => (props.open.kind === "new" ? t().createKeyFor({ name: props.agent.name }) : (openKey()?.name ?? t().keys));

  return (
    <Workspace
      sidebar={<AccountsNav active="agents" pendingRequests={props.pendingRequests} />}
      head={
        <Bar
          start={<RecordHead name={props.agent.name} kinds={[t().agent, status()]} />}
          end={
            <Button variant="primary" icon="plus" href={href("new")} disabled={!props.agent.active}>
              {t().createKey}
            </Button>
          }
        />
      }
      primary={props.agent.active ? { label: t().createKey, icon: "plus", href: href("new") } : undefined}
    >
      <Pane.Split>
        <Pane
          label={t().keys}
          scrollKey="accounts-agent-keys"
          status={
            <StatusRow
              lead={props.keys ? t().keysCount({ count: props.keys.length }) : t().keys}
              filters={
                // k2b-ui gap: a table head cannot be pressed to sort; the order is a row of pressed chips, which leaves on the phone
                <>
                  {AGENT_KEY_SORTS.map((sort) => (
                    <Chip href={agentPageHref(props.agent.id, { sort })} pressed={props.sort === sort}>
                      {sortLabel(t(), sort)}
                    </Chip>
                  ))}
                </>
              }
            />
          }
        >
          <Show when={!props.agent.active}>
            <Notice tone="warn" icon="alert-triangle">
              {t().agentDisabledNotice}
            </Notice>
          </Show>
          <Band>
            <Text>{t().keysIntro}</Text>
          </Band>
          <Show when={props.keys} fallback={<Failed text={t().keysFailed} onRetry={() => void showChanges()} />}>
            {(keys) => (
              <Table
                label={t().keys}
                rows={keys()}
                rowKey={(entry) => entry.id}
                current={openKey()?.id}
                open={(entry) => ({ href: href(entry.id) })}
                sort={{
                  column: props.sort === "used" ? 2 : props.sort === "name" ? 0 : 3,
                  direction: props.sort === "name" ? "ascending" : "descending",
                }}
                empty={{
                  icon: "key",
                  text: t().noKeys,
                  action: props.agent.active ? { label: t().createKey, icon: "plus", href: href("new") } : undefined,
                }}
                phone={(entry) => ({
                  lines: [
                    entry.name,
                    `${accessLabel(t(), entry.access)} · ${entry.lastUsed ? t().usedAgo({ when: entry.lastUsed }) : t().neverUsed}`,
                  ],
                })}
                columns={[
                  {
                    title: t().name,
                    width: { min: 180, default: 240 },
                    cell: (entry) => ({ lines: [entry.name, `${entry.tokenPrefix}…`] }),
                  },
                  { title: t().keyAccess, width: { min: 120, default: 150 }, cell: (entry) => accessLabel(t(), entry.access), drop: true },
                  {
                    title: t().lastUsed,
                    width: { min: 120, default: 150 },
                    cell: (entry) => entry.lastUsed ?? t().neverUsed,
                    drop: true,
                  },
                  { title: t().created, width: { min: 120, default: 150 }, cell: (entry) => entry.created, drop: true },
                  {
                    title: t().status,
                    cell: (entry) => (entry.expired ? <Chip status="warn">{t().expired}</Chip> : <Chip status="ok">{t().keyActive}</Chip>),
                  },
                ]}
              />
            )}
          </Show>
        </Pane>
        <Show
          when={props.open.kind !== "none"}
          fallback={
            <Pane side label={t().details} width={{ min: 260, default: 320 }}>
              {/* k2b-ui gap: RecordHead and Avatar show initials only; the agent's picture (robot or photo) and its
                  change button stand in a Canvas until a v2 avatar takes a picture */}
              <Canvas label={t().picture} height={88}>
                <AgentPictureTrigger id={props.agent.id} name={props.agent.name} avatarHash={props.agent.avatarHash} />
              </Canvas>
              <Section title={t().agent}>
                <Facts
                  items={[
                    { label: t().status, value: <Chip status={props.agent.active ? "ok" : "bad"}>{status()}</Chip> },
                    { label: t().created, value: props.agent.created },
                    {
                      label: t().createdBy,
                      value: props.agent.createdBy ? <Text href={props.agent.createdBy.href}>{props.agent.createdBy.name}</Text> : "–",
                    },
                  ]}
                />
              </Section>
            </Pane>
          }
        >
          {/* k2b-ui gap: no v2 Dialog yet; creating and revoking stand in a detail pane named by the address */}
          <Pane
            detail
            label={detailTitle()}
            width={{ min: 320, default: 400 }}
            back={{ label: t().keys, href: href() }}
            head={
              <Bar
                start={<Text type="lead">{detailTitle()}</Text>}
                end={<Button variant="ghost" icon="x" label={t().close} href={href()} />}
              />
            }
          >
            <Show when={props.open.kind === "new"}>
              <NewKey agent={props.agent} modelsAvailable={props.modelsAvailable} close={href()} />
            </Show>
            <Show when={props.open.kind === "key"}>
              <Show
                when={openKey()}
                fallback={
                  <Notice tone="bad" icon="alert-circle">
                    {t().keyNotFound}
                  </Notice>
                }
              >
                {(entry) => <OpenKey agentId={props.agent.id} entry={entry()} close={href()} />}
              </Show>
            </Show>
          </Pane>
        </Show>
      </Pane.Split>
    </Workspace>
  );
}
