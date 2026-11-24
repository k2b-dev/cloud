import {
  Band,
  Bar,
  Button,
  Canvas,
  Chip,
  Facts,
  Failed,
  Notice,
  Pane,
  RecordHead,
  Section,
  StatusRow,
  Table,
  Text,
  Workspace,
} from "@k2b/ui/v2";
import { Show } from "solid-js";
import { usePageSwap } from "@/frontend/lib/page-swap";
import AccountsNav from "../AccountsNav";
import { type AgentKeyView, accessLabel, NewKeyDialog, OpenKey } from "./AgentKeyDialogs";
import AgentPictureTrigger from "./AgentPictureTrigger";
import { AGENT_KEY_SORTS, type AgentKeyOpen, type AgentKeySort, agentPageHref } from "./agent-keys";
import { type AgentMessages, useAgentMessages } from "./messages";

export type { AgentKeyView } from "./AgentKeyDialogs";

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
  /** How many active keys the agent has; the page lists at most the service's page of them. */
  keysTotal: number;
  sort: AgentKeySort;
  open: AgentKeyOpen;
  modelsAvailable: boolean;
  pendingRequests: number;
};

const sortLabel = (t: AgentMessages, sort: AgentKeySort) => (sort === "name" ? t.sortName : sort === "used" ? t.sortUsed : t.sortCreated);
/**
 * An agent's page on v2: its name and picture, and its access: the API keys in the chosen order, each of which opens
 * beside the list. What is open (the dialog for a new key, one key) and the order live in the address. A new key's token
 * exists only in the dialog's memory until it closes.
 */
export default function AgentScreen(props: Props) {
  const t = useAgentMessages();
  const { showChanges, openPage } = usePageSwap();
  const href = (open?: string) => agentPageHref(props.agent.id, { sort: props.sort, open });
  const status = () => (props.agent.active ? t().active : t().disabled);
  // What is open stays open when the order changes.
  const openParam = () => (props.open.kind === "new" ? "new" : props.open.kind === "key" ? props.open.id : undefined);
  const openKey = () => {
    const open = props.open;
    return open.kind === "key" ? (props.keys?.find((entry) => entry.id === open.id) ?? null) : null;
  };

  return (
    <Workspace
      sidebar={<AccountsNav active="agents" pendingRequests={props.pendingRequests} />}
      head={
        <Bar
          start={<RecordHead name={props.agent.name} kinds={[t().agent, status()]} />}
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
          status={
            <StatusRow
              lead={props.keys ? t().keysCount({ count: props.keysTotal }) : t().keys}
              filters={
                // k2b-ui gap: a table head cannot be pressed to sort; the order is a row of pressed chips, which leaves on the phone
                <>
                  {AGENT_KEY_SORTS.map((sort) => (
                    <Chip href={agentPageHref(props.agent.id, { sort, open: openParam() })} pressed={props.sort === sort}>
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
                // the newest first has no column of its own; the created date stands in the open key
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
                    `${accessLabel(t(), entry.access)} · ${entry.expired ? t().expired : entry.lastUsed ? t().usedAgo({ when: entry.lastUsed }) : t().neverUsed}`,
                  ],
                })}
                columns={[
                  {
                    title: t().name,
                    width: { min: 160, default: 200 },
                    cell: (entry) => ({ lines: [entry.name, `${entry.tokenPrefix}…`] }),
                  },
                  { title: t().keyAccess, width: { min: 150, default: 170 }, cell: (entry) => accessLabel(t(), entry.access), drop: true },
                  {
                    title: t().lastUsed,
                    width: { min: 120, default: 140 },
                    cell: (entry) => entry.lastUsed ?? t().neverUsed,
                    drop: true,
                  },
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
          when={props.open.kind === "key"}
          fallback={
            <Pane side label={t().details} width={{ min: 260, default: 320 }}>
              {/* k2b-ui gap: RecordHead and Avatar show initials only; the agent's picture (robot or photo) and its
                  change button stand in a Canvas until a v2 avatar takes a picture */}
              <Canvas label={t().picture} height={96}>
                {/* the picture stands on the column's text edge, below the pane's top, like the facts under it */}
                <div style={{ padding: "16px var(--k2-edge) 16px" }}>
                  <AgentPictureTrigger id={props.agent.id} name={props.agent.name} avatarHash={props.agent.avatarHash} />
                </div>
              </Canvas>
              <Section title={t().agent}>
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
            </Pane>
          }
        >
          <Pane
            detail
            label={openKey()?.name ?? t().keys}
            width={{ min: 320, default: 380 }}
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
