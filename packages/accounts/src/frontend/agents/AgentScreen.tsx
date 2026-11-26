import { useLocale } from "@k2b/ui";
import { Bar, Cells, Chip, Facts, Notice, Pane, RecordHead, Section, Text, Workspace } from "@k2b/ui/v2";
import { Show } from "solid-js";
import AccountsNav from "../AccountsNav";
import { useAccountsMessages } from "../messages";
import ApiKeysSection from "../service-accounts/ApiKeysSection";
import type { KeyPage } from "../service-accounts/account-keys";
import DirectoryAccessSection, { type DirectoryPage } from "../service-accounts/DirectoryAccessSection";
import { directoryMessages } from "../service-accounts/directory-messages";
import { useAgentPictureChange } from "./agent-picture";
import { useAgentMessages } from "./messages";

/** One data colour per area of the record, the same in its cell and its section. */
const area = { keys: "#8e1b6f", directory: "#0f766e", person: "#2563eb" };

export type AgentView = {
  id: string;
  name: string;
  active: boolean;
  /** The address of the agent's picture, its photo or its robot. */
  image: string | undefined;
  created: string;
  createdBy: { name: string; href: string; image?: string } | null;
};

type Props = {
  agent: AgentView;
  /** The first page of the agent's API keys, as `firstKeyPage` read it; null when it could not be read. */
  keys: KeyPage | null;
  /** The first page of its directory access; undefined when it could not be read, the section then loads it. */
  directory: DirectoryPage | undefined;
  modelsAvailable: boolean;
  timeZone: string;
  pendingRequests: number;
};

/**
 * The agent kind of the account record: the agent's name, picture and state in the head; its key figures; its API
 * keys and its directory access as the sections every service account shows (lane C); beside them who created it and
 * what a key reaches. Keys open, are created and revoked inside their section.
 */
export default function AgentScreen(props: Props) {
  const t = useAgentMessages();
  const accounts = useAccountsMessages();
  const locale = useLocale();
  const changePicture = useAgentPictureChange(() => props.agent);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const status = () => (props.agent.active ? t().active : t().disabled);

  return (
    <Workspace
      sidebar={<AccountsNav active="agents" pendingRequests={props.pendingRequests} />}
      head={
        <Bar
          start={<RecordHead name={props.agent.name} avatar={{ name: props.agent.name, image: props.agent.image }} kinds={[t().agent]} />}
        />
      }
    >
      <Pane label={t().agent} scrollKey="accounts-agent-record">
        <Show when={!props.agent.active}>
          <Notice tone="warn" icon="alert-triangle">
            {t().agentDisabledNotice}
          </Notice>
        </Show>
        <Cells>
          <Cells.Cell
            icon={props.agent.active ? "robot" : "robot-off"}
            label={t().status}
            value={<Chip status={props.agent.active ? "ok" : "warn"}>{status()}</Chip>}
            meta={props.agent.created}
          />
          <Cells.Cell
            icon="key"
            color={area.keys}
            label={t().keys}
            value={props.keys ? number(props.keys.total) : "–"}
            meta={props.keys ? undefined : t().keysFailed}
          />
          <Cells.Cell
            icon="address-book"
            color={area.directory}
            label={directoryMessages.resolve([locale()]).t.title}
            value={props.directory ? number(props.directory.total) : "–"}
          />
          <Cells.Cell
            icon="user"
            color={area.person}
            label={t().createdBy}
            value={props.agent.createdBy?.name ?? "–"}
            href={props.agent.createdBy?.href}
          />
        </Cells>
        <Pane.Split>
          <Pane label={t().keys}>
            <ApiKeysSection
              account={{ kind: "agent", id: props.agent.id, name: props.agent.name, active: props.agent.active }}
              first={props.keys}
              modelsAvailable={props.modelsAvailable}
              timeZone={props.timeZone}
            />
            <DirectoryAccessSection account={{ id: props.agent.id, name: props.agent.name }} initial={props.directory} />
          </Pane>
          <Pane side label={t().details} width={{ min: 300, default: 380 }}>
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
                  { label: t().legacyLimited, value: t().reachLegacy },
                ]}
              />
            </Section>
          </Pane>
        </Pane.Split>
      </Pane>
    </Workspace>
  );
}
