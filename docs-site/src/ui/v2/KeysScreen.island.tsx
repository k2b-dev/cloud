import { Avatar, Bar, Button, Chip, Facts, Nav, Notice, Pane, RecordHead, Section, StatusRow, Table, Workspace } from "@k2b/ui/v2";
import { createSignal } from "solid-js";

// An agent's keys in Accounts, with the states of the primitives: a picture in the record head (and the initials
// where a picture fails), heads that sort, a busy button, a disabled deed of a notice, and facts with a token. What
// the person may read but not change is facts too, never a disabled form. An island, so the heads sort and the button
// turns busy. On the phone the side column stands under the table, with one line between them.

const robot = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#7c3aed"/><rect x="8" y="10" width="16" height="13" rx="3" fill="#fff"/><circle cx="13" cy="16" r="2" fill="#7c3aed"/><circle cx="19" cy="16" r="2" fill="#7c3aed"/></svg>',
)}`;

type Key = { id: string; name: string; prefix: string; used: string; access: string };
const keys: readonly Key[] = [
  { id: "k1", name: "Laptop Jana", prefix: "k2b_sa_7f3a", used: "2026-11-24", access: "Voll" },
  { id: "k2", name: "MCP-Server Team Ops", prefix: "k2b_sa_91c0", used: "2026-11-12", access: "Nur Modelle" },
  { id: "k3", name: "Nachtlauf", prefix: "k2b_sa_0be4", used: "2026-10-02", access: "Voll" },
];
const shown = (date: string) => date.split("-").reverse().join(".");

type Sort = { column: 0 | 1; direction: "ascending" | "descending" };

export default function KeysScreen() {
  const [sort, setSort] = createSignal<Sort>({ column: 1, direction: "descending" });
  const [saving, setSaving] = createSignal(false);
  const rows = () => {
    const by = sort().column === 0 ? (key: Key) => key.name : (key: Key) => key.used;
    const sorted = [...keys].sort((a, b) => by(a).localeCompare(by(b)));
    return sort().direction === "descending" ? sorted.reverse() : sorted;
  };
  // a press on the sorted column turns its order round; another column starts with its natural order
  const press = (column: 0 | 1) => () =>
    setSort((now) => ({
      column,
      direction:
        now.column === column ? (now.direction === "ascending" ? "descending" : "ascending") : column === 0 ? "ascending" : "descending",
    }));
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
                { label: "Personen", icon: "user", count: 48 },
                { label: "Gruppen", icon: "users-group", count: 6 },
                { label: "Agenten", icon: "robot", count: 3, current: true },
              ],
            },
          ]}
        />
      }
      head={
        <Bar
          start={<RecordHead name="Wochenbericht" avatar={{ name: "Wochenbericht", image: robot }} kinds={["Agent", "Pausiert"]} />}
          end={
            <Button variant="primary" icon="plus">
              Schlüssel erstellen
            </Button>
          }
        />
      }
      primary={{ label: "Schlüssel erstellen", icon: "plus" }}
    >
      <Pane.Split>
        <Pane label="Schlüssel" status={<StatusRow lead="3 Schlüssel" />}>
          <Notice tone="warn" actions={[{ label: "Fortsetzen", disabled: true }]}>
            Der Agent ist pausiert; seine Schlüssel gelten erst wieder, wenn eine Admin-Person ihn fortsetzt.
          </Notice>
          <Table
            label="Schlüssel"
            rows={rows()}
            rowKey={(key) => key.id}
            sort={sort()}
            phone={(key) => ({ lines: [key.name, `${key.access} · zuletzt genutzt ${shown(key.used)}`] })}
            columns={[
              {
                title: "Name",
                width: { min: 160, default: 220 },
                sort: { onSort: press(0) },
                cell: (key) => ({ lines: [key.name, `${key.prefix}…`] }),
              },
              {
                title: "Zuletzt genutzt",
                width: { min: 130, default: 150 },
                sort: { onSort: press(1) },
                cell: (key) => shown(key.used),
                drop: true,
              },
              { title: "Zugriff", width: { min: 110, default: 130 }, cell: (key) => key.access, drop: true },
              { title: "Status", cell: () => <Chip status="ok">aktiv</Chip> },
            ]}
          />
        </Pane>
        <Pane side label="Angaben" width={{ min: 260, default: 320 }}>
          <Bar
            start={<Avatar name="Wochenbericht" image={robot} />}
            end={
              <Button
                busy={saving()}
                onClick={() => {
                  // a demo: the upload "takes" a moment
                  setSaving(true);
                  setTimeout(() => setSaving(false), 1500);
                }}
              >
                Bild ändern
              </Button>
            }
          />
          <Section title="Agent">
            <Facts
              items={[
                { label: "Erstellt von", value: "Jana Berger" },
                { label: "Zuletzt genutzt", value: "24.11.2026, 18:02" },
                { label: "Token", value: "k2b_sa_7f3a0c9e51d24b8f9a6e", mono: true, copy: "k2b_sa_7f3a0c9e51d24b8f9a6e" },
              ]}
            />
          </Section>
          {/* values the person may read but not change are facts, not a disabled form */}
          <Section title="Zugang">
            <Facts
              items={[
                { label: "Gültig bis", value: "31.12.2026" },
                { label: "Zugriff", value: "Voll" },
                { label: "Bei Nutzung", value: "benachrichtigen" },
              ]}
            />
          </Section>
        </Pane>
      </Pane.Split>
    </Workspace>
  );
}
