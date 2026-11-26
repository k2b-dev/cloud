// Recipe: a page for visitors without the Cloud shell (a venue's programme, a public form, a share). The brand stands
// in the head with its colour, the one task is the head's primary, the first row says what matters today, and every
// entry carries its type colour and its state in colour, sign and word. `kiosk`: the same page on a wall screen in the
// foyer, without a task, with what runs now first and a quiet note that it refreshes itself.

import {
  Bar,
  Button,
  Cells,
  Chip,
  Empty,
  Failed,
  Notice,
  Pane,
  Progress,
  RecordHead,
  Row,
  Section,
  StatusRow,
  Text,
  Workspace,
} from "@k2b/ui/v2";
import { Show } from "solid-js";

const brand = { name: "Kulturhaus Lindenhof", color: "#9a3412" };
const kinds = {
  reading: { icon: "book-2", color: "#7c3aed", label: "Lesung" },
  concert: { icon: "music", color: "#0e7490", label: "Konzert" },
  workshop: { icon: "tools", color: "#b45309", label: "Werkstatt" },
  film: { icon: "movie", color: "#be123c", label: "Film" },
  talk: { icon: "messages", color: "#15803d", label: "Gespräch" },
} as const;
type Kind = keyof typeof kinds;
type Seats = { free: number; of: number };
type Event = { title: string; kind: Kind; time: string; room: string; seats: Seats; host?: string };

const today: Event[] = [
  { title: "Offene Holzwerkstatt", kind: "workshop", time: "14:00–17:00", room: "Werkraum", seats: { free: 3, of: 12 }, host: "Ali Demir" },
  {
    title: "Stadtgeschichten: Der Lindenhof 1920–1960",
    kind: "reading",
    time: "18:30–20:00",
    room: "Saal 2",
    seats: { free: 12, of: 40 },
    host: "Dr. Henrike Vogt",
  },
  {
    title: "Kammermusik am Abend – Schubert, Fauré",
    kind: "concert",
    time: "20:00–21:30",
    room: "Großer Saal",
    seats: { free: 0, of: 120 },
  },
  { title: "Kurzfilmnacht: Nachbarschaften", kind: "film", time: "21:45–23:30", room: "Saal 1", seats: { free: 34, of: 60 } },
];
const week: Event[] = [
  { title: "Sprachcafé Deutsch–Ukrainisch", kind: "talk", time: "Do 17:00", room: "Café", seats: { free: 18, of: 25 } },
  { title: "Kinder-Theaterwerkstatt", kind: "workshop", time: "Fr 15:30", room: "Werkraum", seats: { free: 2, of: 14 } },
  { title: "Jazz-Session mit offener Bühne", kind: "concert", time: "Fr 20:00", room: "Großer Saal", seats: { free: 61, of: 120 } },
  { title: "Lyrik aus dem Stadtteil", kind: "reading", time: "Sa 11:00", room: "Saal 2", seats: { free: 22, of: 40 } },
  { title: "Dokumentarfilm: Der letzte Bäcker", kind: "film", time: "Sa 19:00", room: "Saal 1", seats: { free: 5, of: 60 } },
  { title: "Podium: Wohnen im Quartier", kind: "talk", time: "So 16:00", room: "Großer Saal", seats: { free: 44, of: 120 } },
];

/** The state of the seats in colour, sign and word; never a colour alone. */
const seatsChip = (seats: Seats) =>
  seats.free === 0 ? (
    <Chip status="bad">Ausgebucht</Chip>
  ) : seats.free <= Math.max(3, seats.of / 10) ? (
    <Chip status="warn">{`Noch ${seats.free}`}</Chip>
  ) : (
    <Chip status="ok">{`${seats.free} frei`}</Chip>
  );

const eventRow = (event: Event) => (
  <Row
    icon={kinds[event.kind].icon}
    color={kinds[event.kind].color}
    lines={[event.title, `${event.time} · ${event.room}${event.host ? ` · ${event.host}` : ""}`]}
    meta={kinds[event.kind].label}
    end={seatsChip(event.seats)}
    href="#termin"
  />
);

type Props = { kiosk?: boolean; empty?: boolean; failed?: boolean };

export default function VenueProgramme(props: Props) {
  const events = () => (props.empty ? [] : today);
  const free = () => events().reduce((sum, event) => sum + event.seats.free, 0);
  const seats = () => events().reduce((sum, event) => sum + event.seats.of, 0);
  const reserve = { label: "Platz reservieren", icon: "ticket", href: "#reservieren" };
  return (
    <Workspace
      primary={props.kiosk ? undefined : reserve}
      head={
        <Bar
          start={<RecordHead name={brand.name} avatar={{ name: brand.name, initials: "KL", color: brand.color }} kinds={["Programm"]} />}
          end={
            props.kiosk ? (
              <Text type="meta">Mittwoch, 26. November</Text>
            ) : (
              <Button variant="primary" icon="ticket" href="#reservieren">
                Platz reservieren
              </Button>
            )
          }
        />
      }
    >
      <Pane
        label="Programm"
        status={
          <StatusRow
            lead={props.kiosk ? "Jetzt: Offene Holzwerkstatt · Werkraum" : `Heute ${events().length} Veranstaltungen`}
            facts={[
              { value: String(free()), after: `von ${seats()} Plätzen frei` },
              { before: "Einlass", value: "30 Min. vorher" },
              ...(props.kiosk ? [{ after: "aktualisiert sich jede Minute" }] : []),
            ]}
            loading={props.kiosk ? false : undefined}
          />
        }
      >
        <Show
          when={!props.failed}
          fallback={<Failed text="Das Programm konnte nicht geladen werden. Die Reservierung bleibt möglich." onRetry={() => {}} />}
        >
          <Show
            when={events().length > 0}
            fallback={<Empty icon="calendar-off" text="Heute keine Veranstaltung. Das Programm der Woche steht unten." />}
          >
            <Cells>
              <Cells.Cell icon="clock" color={kinds.reading.color} label="Als Nächstes" value="18:30" meta="Stadtgeschichten · Saal 2" />
              <Cells.Cell icon="armchair" color={brand.color} label="Plätze heute" value={`${free()} frei`} meta={`von ${seats()}`} />
              <Cells.Cell icon="door-enter" color="#15803d" label="Einlass" value="ab 14:00" meta="Haupteingang Lindenstraße 4" />
            </Cells>
            <Section icon="calendar-event" title="Heute" count={events().length}>
              {events().map(eventRow)}
            </Section>
          </Show>
          <Section icon="calendar-week" title="Diese Woche" count={week.length}>
            {week.map(eventRow)}
          </Section>
          <Section icon="armchair" title="Auslastung der Säle">
            <Row
              icon="building"
              color={brand.color}
              lines={["Großer Saal", "Kammermusik · 120 Plätze"]}
              end={<Progress value={120} of={120} label="Großer Saal 120 von 120 belegt" />}
            />
            <Row
              icon="building"
              color={brand.color}
              lines={["Saal 2", "Stadtgeschichten · 40 Plätze"]}
              end={<Progress value={28} of={40} label="Saal 2 28 von 40 belegt" />}
            />
          </Section>
          <Show when={!props.kiosk}>
            <Notice tone="note" title="Barrierefrei">
              Alle Säle sind stufenlos über den Hof erreichbar. Eine Höranlage gibt es im Großen Saal.
            </Notice>
          </Show>
        </Show>
      </Pane>
    </Workspace>
  );
}

export const states = {
  kiosk: () => <VenueProgramme kiosk />,
  empty: () => <VenueProgramme empty />,
  failed: () => <VenueProgramme failed />,
};
