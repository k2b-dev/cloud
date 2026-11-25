import {
  Avatar,
  Bar,
  Button,
  Check,
  Chip,
  Choice,
  Facts,
  Field,
  Input,
  List,
  Nav,
  Notice,
  Pane,
  RecordHead,
  Row,
  Section,
  StatusRow,
  Table,
  Workspace,
} from "../src/v2";

// The states the agent page of Accounts asked for (lane F, #4110), on one screen of primitives only: a record head
// with a picture, a table sorted by pressing its heads, a busy button, disabled fields and a disabled deed of a notice,
// facts with a monospace token and a long label, and a side column that stands under the table on the phone.

/** A picture as an address of its own (no network): a round face on blue. */
export const robot = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#2563eb"/><rect x="8" y="10" width="16" height="13" rx="3" fill="#fff"/><circle cx="13" cy="16" r="2" fill="#2563eb"/><circle cx="19" cy="16" r="2" fill="#2563eb"/></svg>',
)}`;
/** An address that never loads a picture: the initials stay. */
export const broken = "data:image/png;base64,AAAA";

export type AccessKey = { id: string; name: string; prefix: string; used: string };
export const accessKeys: readonly AccessKey[] = [
  { id: "k1", name: "Laptop Jana", prefix: "k2b_sa_7f3a", used: "24.11.2026" },
  { id: "k2", name: "MCP-Server Team Ops", prefix: "k2b_sa_91c0", used: "12.11.2026" },
  { id: "k3", name: "Nachtlauf", prefix: "k2b_sa_0be4", used: "02.10.2026" },
];

export type AccessSort = { column: 0 | 1; direction: "ascending" | "descending" };

export const AccessScreen = (props: {
  sort: AccessSort;
  /** Pressing a head that sorts: without it the heads are links to `?sort=…`. */
  onSort?: (column: 0 | 1) => void;
  busy?: boolean;
  /** The large table (a sticky first column), which keeps its own last line. */
  grid?: boolean;
  onPicture?: () => void;
  /** The agent is a favourite: the star in the head is a toggle that is on. */
  favourite?: boolean;
  onFavourite?: () => void;
  onResume?: () => void;
}) => {
  const rows = () => {
    const sorted = [...accessKeys].sort((a, b) => (props.sort.column === 0 ? a.name.localeCompare(b.name) : a.used.localeCompare(b.used)));
    return props.sort.direction === "descending" ? sorted.reverse() : sorted;
  };
  // a press on the sorted column turns its order round; another column starts ascending
  const next = (column: 0 | 1) =>
    props.sort.column === column && props.sort.direction === "ascending" ? `?sort=-${column}` : `?sort=${column}`;
  const target = (column: 0 | 1) => (props.onSort ? { onSort: () => props.onSort?.(column) } : { href: next(column) });
  return (
    <Workspace
      sidebarLabel="Breite der Seitenleiste"
      sidebar={
        <Nav
          title="Konten"
          icon="users"
          groups={[
            {
              items: [
                { label: "Personen", icon: "user" },
                { label: "Agenten", icon: "robot", current: true },
              ],
            },
          ]}
        />
      }
      head={
        <Bar
          start={<RecordHead name="Wochenbericht" avatar={{ name: "Wochenbericht", image: robot }} kinds={["Agent", "Pausiert"]} />}
          end={
            <>
              <Button
                variant="ghost"
                icon="star"
                label="Favorit"
                pressed={props.favourite ?? false}
                onClick={() => props.onFavourite?.()}
              />
              <Button variant="primary" icon="plus">
                Schlüssel erstellen
              </Button>
            </>
          }
        />
      }
      primary={{ label: "Schlüssel erstellen", icon: "plus" }}
    >
      <Pane.Split>
        <Pane label="Schlüssel" status={<StatusRow lead="3 Schlüssel" />}>
          <Notice tone="warn" actions={[{ label: "Fortsetzen", disabled: true, onClick: () => props.onResume?.() }]}>
            Der Agent ist pausiert. Fortsetzen kann ihn nur eine Admin-Person.
          </Notice>
          <Table
            label="Schlüssel"
            rows={rows()}
            rowKey={(entry) => entry.id}
            sort={props.sort}
            sticky={props.grid}
            open={(entry) => ({ href: `?key=${entry.id}` })}
            phone={(entry) => ({ lines: [entry.name, `zuletzt genutzt ${entry.used}`] })}
            columns={[
              {
                title: "Name",
                width: { min: 160, default: 220 },
                sort: target(0),
                cell: (entry) => ({ lines: [entry.name, `${entry.prefix}…`] }),
              },
              { title: "Zuletzt genutzt", width: { min: 130, default: 150 }, sort: target(1), cell: (entry) => entry.used, drop: true },
              { title: "Status", cell: () => <Chip status="ok">aktiv</Chip> },
            ]}
          />
        </Pane>
        <Pane side label="Angaben" width={{ min: 260, default: 320 }}>
          <Bar
            start={<Avatar name="Jana Berger" image={broken} />}
            end={
              <Button busy={props.busy} onClick={() => props.onPicture?.()}>
                Bild ändern
              </Button>
            }
          />
          <Section title="Agent">
            <Facts
              items={[
                { label: "Zuletzt genutzt", value: "24.11.2026, 18:02" },
                { label: "Token", value: "k2b_sa_7f3a0c9e51d24b8f9a6e", mono: true, copy: "k2b_sa_7f3a0c9e51d24b8f9a6e" },
              ]}
            />
          </Section>
          <Section title="Zugang" more={{ label: "Zugang ändern", href: "?access", disabled: true }}>
            <Field name="until" label="Gültig bis" hint="Ändern kann nur eine Admin-Person.">
              <Input value="31.12.2026" disabled />
            </Field>
            <Field name="access" label="Zugriff">
              <Choice name="access" options={["Voll", "Nur Modelle"]} value="Voll" disabled />
            </Field>
            <Check name="notify" label="Bei Nutzung benachrichtigen" checked disabled />
          </Section>
          <Section title="Erstellt von">
            <List>
              <Row avatar={{ name: "Jana Berger", image: robot }} lines={["Jana Berger", "22.09.2026"]} />
            </List>
          </Section>
        </Pane>
      </Pane.Split>
    </Workspace>
  );
};
