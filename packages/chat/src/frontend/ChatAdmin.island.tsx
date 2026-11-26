import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { Bar, Button, Cells, Chip, List, type NavProps, Notice, Pane, Row, Section, StatusRow } from "@k2b/ui/v2";
import type { JSX } from "solid-js";

/** Chat's operational state as the server read it, in the words of the page's language. */
export type ChatAdminView = {
  nav: NavProps;
  title: string;
  ok: boolean;
  /** "Healthy" or "Unavailable", the page's one statement. */
  state: string;
  observed: string;
  labels: { database: string; notifications: string; providers: string; logs: string };
  database: { ready: boolean; value: string; latency?: string };
  notifications: { status: "ok" | "unchecked" | "failing" | "not_configured"; value: string; detail?: string };
  /** Places whose discussions cannot notify now, with the reason and when it was seen. */
  providers: readonly { type: string; line: string }[];
};

/**
 * `/admin/chat` on @k2b/ui v2: one statement (ready or not, when seen), the checks behind it side by side, the places that
 * cannot notify as rows, and the way to Chat's logs. Good is neutral; only a problem has colour.
 */
/** Good stays plain words; only a problem is a coloured state. */
const state = (tone: "bad" | "warn" | undefined, text: string): JSX.Element => (tone ? <Chip status={tone}>{text}</Chip> : text);

export default function ChatAdmin(props: { view: ChatAdminView }): JSX.Element {
  const view = () => props.view;
  return (
    <AdminWorkspace
      nav={view().nav}
      head={
        <Bar
          end={
            <Button icon="file-search" keep href="/admin/observability/logs?search=chat">
              {view().labels.logs}
            </Button>
          }
        />
      }
    >
      <Pane label={view().title} status={<StatusRow lead={view().state} facts={[{ value: view().observed }]} />}>
        {/* k2b-ui gap (DP): the hero band with its figure; the statement stands in the status row until it lands. */}
        <Cells>
          <Cells.Cell
            icon="database"
            label={view().labels.database}
            value={state(view().database.ready ? undefined : "bad", view().database.value)}
            meta={view().database.latency}
          />
          <Cells.Cell
            icon="bell"
            label={view().labels.notifications}
            value={state(
              view().notifications.status === "failing" ? "bad" : view().notifications.status === "ok" ? undefined : "warn",
              view().notifications.value,
            )}
            meta={view().notifications.detail}
          />
        </Cells>
        {view().notifications.status === "failing" && view().providers.length === 0 && view().notifications.detail ? (
          <Notice tone="bad">{view().notifications.detail}</Notice>
        ) : null}
        {view().providers.length > 0 ? (
          <Section title={view().labels.providers} count={view().providers.length}>
            <List label={view().labels.providers}>
              {view().providers.map((provider) => (
                <Row icon="alert-triangle" lines={[provider.type, provider.line]} />
              ))}
            </List>
          </Section>
        ) : null}
      </Pane>
    </AdminWorkspace>
  );
}
