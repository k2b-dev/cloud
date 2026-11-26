import { Band, Bar, Button, Chip, Facts, Failed, Notice, Pane, RecordHead, Section, StatusRow, Table, Text, Workspace } from "@k2b/ui/v2";
import { Show } from "solid-js";
import { usePageSwap } from "@/frontend/lib/page-swap";
import AccountsNav from "../AccountsNav";
import { useAccountsMessages } from "../messages";
import { type AgentKeyView, accessLabel, NewKeyDialog, OpenKey } from "./AgentKeyDialogs";
import { type AgentKeyOpen, type AgentKeySort, agentPageHref } from "./agent-keys";
import { useAgentPictureChange } from "./agent-picture";
import { useAgentMessages } from "./messages";

export type { AgentKeyView } from "./AgentKeyDialogs";

/** The side column and an open key share one width, so the table's edge stays where it is when a key opens. */
const sideWidth = { min: 300, default: 380 };

export type AgentView = {
  id: string;
  name: string;
  active: boolean;
  /** The address of the agent's picture, its photo or its robot. */
  image: string | undefined;
  created: string;
  createdBy: { name: string; href: string } | null;
};

type Props = {
  agent: AgentView;
  /** The keys in the chosen order; null when they could not be loaded. */
  keys: readonly AgentKeyView[] | null;
  /** How many active keys the agent has; the page lists at most the service's page of them. */
  keysTotal: number;
  sort: AgentKeySort;
  open: AgentKeyOpen;
  modelsAvailable: boolean;
  pendingRequests: number;
};

/**
 * An agent's page on v2: its name and picture, and its access: the API keys in the chosen order, each of which opens
 * beside the list. What is open (the dialog for a new key, one key) and the order live in the address. A new key's token
 * exists only in the dialog's memory until it closes.
 */
export default function AgentScreen(props: Props) {
  const t = useAgentMessages();
  const accounts = useAccountsMessages();
  const { showChanges, openPage } = usePageSwap();
  const changePicture = useAgentPictureChange(() => props.agent);
  const href = (open?: string) => agentPageHref(props.agent.id, { sort: props.sort, open });
  const status = () => (props.agent.active ? t().active : t().disabled);
  // What is open stays open when the order changes.
  const openParam = () => (props.open.kind === "new" ? "new" : props.open.kind === "key" ? props.open.id : undefined);
  // A column head sorts by its column; pressed again, the list goes back to the newest first.
  // A key works only while its agent is active: then expired keys warn and the others are ok; otherwise every key rests.
  const keyStatus = (entry: AgentKeyView): { status?: "ok" | "warn"; label: string } =>
    !props.agent.active
      ? { label: t().keyInactive }
      : entry.expired
        ? { status: "warn", label: t().expired }
        : { status: "ok", label: t().keyActive };
  const sortBy = (sort: AgentKeySort) => ({
    href: agentPageHref(props.agent.id, { sort: props.sort === sort ? "created" : sort, open: openParam() }),
  });
  const openKey = () => {
    const open = props.open;
    return open.kind === "key" ? (props.keys?.find((entry) => entry.id === open.id) ?? null) : null;
  };

  return (
    <Workspace
      sidebar={<AccountsNav active="users" pendingRequests={props.pendingRequests} />}
      head={
        <Bar
          start={
            <RecordHead
              name={props.agent.name}
              avatar={{ name: props.agent.name, image: props.agent.image }}
              kinds={[t().agent, status()]}
            />
          }
          // A disabled agent gets no key: no action, and the notice on the page says why.
          end={
            props.agent.active ? (
              <Button variant="primary" icon="plus" href={href("new")}>
                {t().createKey}
              </Button>
            ) : undefined
          }
        />
      }
      primary={props.agent.active ? { label: t().createKey, icon: "plus", href: href("new") } : undefined}
    >
      <Pane.Split>
        <Pane
          label={t().keys}
          scrollKey="accounts-agent-keys"
          status={<StatusRow lead={props.keys ? t().keysCount({ count: props.keysTotal }) : t().keys} />}
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
                // the newest first has no column of its own: pressing a sorted head again goes back to it
                sort={
                  props.sort === "name"
                    ? { column: 0, direction: "ascending" }
                    : props.sort === "used"
                      ? { column: 2, direction: "descending" }
                      : undefined
                }
                empty={{
                  icon: "key",
                  text: t().noKeys,
                  action: props.agent.active ? { label: t().createKey, icon: "plus", href: href("new") } : undefined,
                }}
                phone={(entry) => ({
                  lines: [
                    entry.name,
                    `${accessLabel(t(), entry.access)} · ${!props.agent.active || entry.expired ? keyStatus(entry).label : entry.lastUsed ? t().usedAgo({ when: entry.lastUsed }) : t().neverUsed}`,
                  ],
                })}
                columns={[
                  {
                    title: t().name,
                    sort: sortBy("name"),
                    width: { min: 160, default: 180 },
                    cell: (entry) => ({ lines: [entry.name, `${entry.tokenPrefix}…`] }),
                  },
                  { title: t().keyAccess, width: { min: 150, default: 170 }, cell: (entry) => accessLabel(t(), entry.access), drop: true },
                  {
                    title: t().lastUsed,
                    sort: sortBy("used"),
                    width: { min: 120, default: 130 },
                    cell: (entry) => entry.lastUsed ?? t().neverUsed,
                    drop: true,
                  },
                  {
                    title: t().status,
                    // a disabled agent's keys rest: a plain chip, as the notice above says
                    cell: (entry) => {
                      const state = keyStatus(entry);
                      return state.status ? <Chip status={state.status}>{state.label}</Chip> : <Chip>{state.label}</Chip>;
                    },
                  },
                ]}
              />
            )}
          </Show>
        </Pane>
        <Show
          when={props.open.kind === "key"}
          fallback={
            <Pane side label={t().details} width={sideWidth}>
              <Section
                title={t().agent}
                actions={[{ label: accounts().agentChangePicture, icon: "photo", onClick: () => void changePicture() }]}
              >
                <Facts
                  items={[
                    { label: t().created, value: props.agent.created },
                    {
                      label: t().createdBy,
                      value: props.agent.createdBy ? <Text href={props.agent.createdBy.href}>{props.agent.createdBy.name}</Text> : "–",
                    },
                  ]}
                />
              </Section>
              {/* what a key can do, in the words of its access; a key lives only as long as its agent is active */}
              <Section title={t().reachTitle} summary={t().reachWhileActive}>
                <Facts
                  items={[
                    { label: t().fullAccess, value: t().reachFull },
                    ...(props.modelsAvailable ? [{ label: t().modelsOnly, value: t().reachModels }] : []),
                    ...(props.keys?.some((entry) => entry.access === "legacy")
                      ? [{ label: t().legacyLimited, value: t().reachLegacy }]
                      : []),
                  ]}
                />
              </Section>
            </Pane>
          }
        >
          <Pane
            detail
            label={openKey()?.name ?? t().keys}
            width={sideWidth}
            back={{ label: t().keys, href: href() }}
            head={
              <Bar
                start={<Text type="lead">{openKey()?.name ?? t().keys}</Text>}
                end={<Button variant="ghost" icon="x" label={t().close} href={href()} />}
              />
            }
          >
            <Show
              when={openKey()}
              fallback={
                <Notice tone="bad" icon="alert-circle">
                  {t().keyNotFound}
                </Notice>
              }
            >
              {(entry) => <OpenKey agentId={props.agent.id} entry={entry()} revoked={() => void openPage(href(), { replace: true })} />}
            </Show>
          </Pane>
        </Show>
      </Pane.Split>
      <NewKeyDialog
        agent={props.agent}
        modelsAvailable={props.modelsAvailable}
        open={props.open.kind === "new"}
        // Closing drops `?key=new` from the address in place, so Back never reopens it; the list shows a created key.
        close={() => void openPage(href(), { replace: true })}
      />
    </Workspace>
  );
}
