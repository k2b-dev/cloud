import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { type NavProps, Pane, Row, Section, StatusRow } from "@k2b/ui/v2";
import { For, Show } from "solid-js";

/** One place an operator can go: a row with its symbol, name and what is done there. */
export type OverviewTask = { href: string; title: string; description: string; icon: string; color?: string };
export type OverviewSection = { title: string; tasks: OverviewTask[] };

export type OverviewScreenProps = {
  nav: NavProps;
  title: string;
  /** "12 registrierte Dienste" and "3 App-Verwaltungsbereiche", worded by the server. */
  lead: string;
  facts: string[];
  sections: OverviewSection[];
};

/** The admin overview on v2: the one statement in the status row, then the places to go as sections of rows. */
export default function OverviewScreen(props: OverviewScreenProps) {
  return (
    // no head that repeats the open entry of the admin bar; the statement leads (k2b-ui gap: the hero band comes with DP)
    <AdminWorkspace nav={props.nav}>
      <Pane
        label={props.title}
        scrollKey="admin-overview"
        status={<StatusRow lead={props.lead} facts={props.facts.map((value) => ({ value }))} />}
      >
        <For each={props.sections}>
          {(section) => (
            <Show when={section.tasks.length > 0}>
              <Section title={section.title}>
                <For each={section.tasks}>
                  {(task) => <Row lines={[task.title, task.description]} icon={task.icon} color={task.color} href={task.href} />}
                </For>
              </Section>
            </Show>
          )}
        </For>
      </Pane>
    </AdminWorkspace>
  );
}
