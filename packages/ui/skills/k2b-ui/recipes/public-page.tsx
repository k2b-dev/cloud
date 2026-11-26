// Recipe: a page for visitors without the Cloud shell (a venue's programme, a public form, a share). The brand stands
// in the head with its colour, the one task is the head's primary (kept on the phone, so nothing floats over a row),
// the status row says what matters today in one statement with toned chips, the programme fills the main column with
// dense rows, and the side column holds the visit: free places as a meter, the way in, the rooms. Every entry carries
// its type colour, the people who host it, its seats as a meter and its state in colour, sign and word. `kiosk`: the
// same page on a wall screen in the foyer, without a task, with what runs now first.

import {
  Avatar,
  Bar,
  Button,
  Chip,
  Facts,
  Failed,
  Inline,
  Notice,
  Pane,
  Progress,
  RecordHead,
  Row,
  Section,
  Table,
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
type Event = { title: string; kind: Kind; time: string; room: string; seats: Seats; host: { name: string; color: string } };

const today: Event[] = [
  {
    title: "Offene Holzwerkstatt",
    kind: "workshop",
    time: "14:00–17:00",
    room: "Werkraum",
    seats: { free: 3, of: 12 },
    host: { name: "Ali Demir", color: "#b45309" },
  },
  {
    title: "Stadtgeschichten: Der Lindenhof 1920–1960",
    kind: "reading",
    time: "18:30–20:00",
    room: "Saal 2",
    seats: { free: 12, of: 40 },
    host: { name: "Dr. Henrike Vogt", color: "#7c3aed" },
  },
  {
    title: "Kammermusik am Abend – Schubert, Fauré",
    kind: "concert",
    time: "20:00–21:30",
    room: "Großer Saal",
    seats: { free: 0, of: 120 },
    host: { name: "Clara Weiß", color: "#0e7490" },
  },
  {
    title: "Kurzfilmnacht: Nachbarschaften",
    kind: "film",
    time: "21:45–23:30",
    room: "Saal 1",
    seats: { free: 34, of: 60 },
    host: { name: "Jonas Becker", color: "#be123c" },
  },
];
const week: Event[] = [
  {
    title: "Sprachcafé Deutsch–Ukrainisch",
    kind: "talk",
    time: "Do 17:00",
    room: "Café",
    seats: { free: 18, of: 25 },
    host: { name: "Olena Koval", color: "#15803d" },
  },
  {
    title: "Kinder-Theaterwerkstatt",
    kind: "workshop",
    time: "Fr 15:30",
    room: "Werkraum",
    seats: { free: 2, of: 14 },
    host: { name: "Mara Okafor", color: "#be185d" },
  },
  {
    title: "Jazz-Session mit offener Bühne",
    kind: "concert",
    time: "Fr 20:00",
    room: "Großer Saal",
    seats: { free: 61, of: 120 },
    host: { name: "Clara Weiß", color: "#0e7490" },
  },
  {
    title: "Lyrik aus dem Stadtteil",
    kind: "reading",
    time: "Sa 11:00",
    room: "Saal 2",
    seats: { free: 22, of: 40 },
    host: { name: "Dr. Henrike Vogt", color: "#7c3aed" },
  },
  {
    title: "Dokumentarfilm: Der letzte Bäcker",
    kind: "film",
    time: "Sa 19:00",
    room: "Saal 1",
    seats: { free: 5, of: 60 },
    host: { name: "Jonas Becker", color: "#be123c" },
  },
  // the worst case of a title: long, with a year range at its end
  {
    title: "Gesprächsreihe Nachbarschaft: Wohnen, Arbeiten und Ankommen im Lindenhof 1950–2025",
    kind: "talk",
    time: "So 11:00",
    room: "Saal 2",
    seats: { free: 31, of: 40 },
    host: { name: "Olena Koval", color: "#15803d" },
  },
  {
    title: "Podium: Wohnen im Quartier",
    kind: "talk",
    time: "So 16:00",
    room: "Großer Saal",
    seats: { free: 44, of: 120 },
    host: { name: "Olena Koval", color: "#15803d" },
  },
];

/** A range of numbers (1920–1960) stays on one line when a title wraps: a word joiner after its dash. */
const keepRanges = (text: string) => text.replace(/(\d)–(\d)/g, "$1–\u2060$2");

const few = (seats: Seats) => seats.free > 0 && seats.free <= Math.max(3, seats.of / 10);

/**
 * The seats: a chip in colour, sign and word only for what asks to act (booked out, almost full); the usual case is
 * quiet text, so the two exceptions stand out.
 */
const seatsChip = (seats: Seats) =>
  seats.free === 0 ? (
    <Chip status="bad" icon="ban">
      Ausgebucht
    </Chip>
  ) : few(seats) ? (
    <Chip status="warn" icon="alert-triangle">{`Noch ${seats.free}`}</Chip>
  ) : (
    <Text muted>{`${seats.free} frei`}</Text>
  );

/** Beside the meter and its words, the chip names only the state: the free seats stand at the meter already. */
const exceptionChip = (seats: Seats) =>
  seats.free === 0 ? (
    <Chip status="bad" icon="ban">
      Ausgebucht
    </Chip>
  ) : (
    <Chip status="warn" icon="alert-triangle">
      knapp
    </Chip>
  );

type Listed = Event & { day: "Heute" | "Diese Woche"; key: string };
const listed = (events: Event[], day: Listed["day"]): Listed[] => events.map((event, index) => ({ ...event, day, key: `${day}-${index}` }));
const taken = (seats: Seats) => seats.of - seats.free;
/** The state of a meter of seats, as its chip says it: almost full, booked out. */
const load = (seats: Seats) => (seats.free === 0 ? ("bad" as const) : few(seats) ? ("warn" as const) : undefined);

/**
 * The programme as one table grouped by day: the event with when and where, its type as a tag in its colour, who
 * hosts it, how full it is as a meter, and its state. On the phone each event is one row of two lines with its state.
 */
const programme = (events: Listed[], kiosk = false) => (
  <Table
    label="Programm"
    rows={events}
    rowKey={(event) => event.key}
    group={(event) => ({
      key: event.day,
      head: () => <Text weight="strong">{event.day}</Text>,
      count: String(events.filter((other) => other.day === event.day).length),
    })}
    open={() => ({ href: "#termin" })}
    columns={[
      {
        title: "Veranstaltung",
        // a long title takes a second line before it is cut: a year range never breaks off in the middle
        wrap: true,
        cell: (event) => ({ lines: [keepRanges(event.title), `${event.time} · ${event.room} · ${kinds[event.kind].label}`] }),
      },
      {
        title: "Leitung",
        width: { fixed: 160 },
        drop: true,
        cell: (event) => (
          <Inline>
            <Avatar name={event.host.name} color={event.host.color} />
            <Text>{event.host.name}</Text>
          </Inline>
        ),
      },
      {
        // the meter and, for the exceptions, their chip: title and seats share the room the host leaves
        title: "Plätze",
        cell: (event) => (
          <Inline>
            <Progress
              value={taken(event.seats)}
              of={event.seats.of}
              // booked out, the chip says it: the words would only repeat it
              label={event.seats.free === 0 ? undefined : `${event.seats.free} frei`}
              status={load(event.seats)}
            />
            {/* on the wall screen what runs now says so on its row; its seats matter less while it runs */}
            <Show when={kiosk && event.key === "Heute-0"} fallback={<Show when={load(event.seats)}>{exceptionChip(event.seats)}</Show>}>
              <Chip status="ok">läuft</Chip>
            </Show>
          </Inline>
        ),
      },
    ]}
    phone={(event) => ({
      lines: [keepRanges(event.title), `${event.time} · ${event.room} · ${kinds[event.kind].label}`],
      avatar: event.host,
      marks: seatsChip(event.seats),
    })}
  />
);

type Props = { kiosk?: boolean; empty?: boolean; failed?: boolean };

export default function VenueProgramme(props: Props) {
  const events = () => (props.empty ? [] : today);
  const free = () => events().reduce((sum, event) => sum + event.seats.free, 0);
  const seats = () => events().reduce((sum, event) => sum + event.seats.of, 0);
  const shown = () => [...events(), ...week];
  const full = () => shown().filter((event) => event.seats.free === 0).length;
  const almost = () => shown().filter((event) => few(event.seats)).length;
  return (
    <Workspace
      head={
        <Bar
          start={<RecordHead name={brand.name} avatar={{ name: brand.name, initials: "KL", color: brand.color }} />}
          end={
            props.kiosk ? (
              <Text type="meta">Mittwoch, 26. November · aktualisiert sich jede Minute</Text>
            ) : (
              // words only: with the brand it stays one row on a phone
              <Button variant="primary" href="#reservieren" keep>
                Reservieren
              </Button>
            )
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label="Programm"
          status={
            <Bar
              start={
                <Inline>
                  {/* the statement names its reference, and its chips count the rows the list shows */}
                  <Text weight="strong">Bis Sonntag</Text>
                  <Show when={almost() > 0}>
                    <Chip status="warn" icon="alert-triangle">{`${almost()} fast voll`}</Chip>
                  </Show>
                  <Show when={full() > 0}>
                    <Chip status="bad" icon="ban">{`${full()} ausgebucht`}</Chip>
                  </Show>
                </Inline>
              }
            />
          }
        >
          <Show
            when={!props.failed}
            fallback={<Failed text="Das Programm konnte nicht geladen werden. Die Reservierung bleibt möglich." onRetry={() => {}} />}
          >
            <Show when={events().length === 0}>
              <Notice tone="note" icon="calendar-off">
                Heute keine Veranstaltung. Das Programm der Woche steht darunter.
              </Notice>
            </Show>
            {programme([...listed(events(), "Heute"), ...listed(week, "Diese Woche")], props.kiosk)}
          </Show>
        </Pane>
        <Pane side label="Ihr Besuch" width={{ fixed: 360 }}>
          <Section icon="armchair" color={brand.color} title="Plätze heute">
            <Row
              lines={[`${free()} von ${seats()} frei`, "über alle Veranstaltungen"]}
              end={<Progress value={seats() - free()} of={seats() || 1} />}
            />
          </Section>
          <Section icon="door-enter" color="#15803d" title="Ihr Weg hinein">
            <Facts
              items={[
                { label: "Einlass", value: "30 Min. vor Beginn" },
                { label: "Eingang", value: "Lindenstraße 4, über den Hof" },
                { label: "Kasse", value: "ab 13:30, nur Karte" },
              ]}
            />
          </Section>
          <Section icon="wheelchair" color="#15803d" title="Barrierefrei">
            <Text>Alle Säle sind stufenlos über den Hof erreichbar. Eine Höranlage gibt es im Großen Saal.</Text>
          </Section>
        </Pane>
      </Pane.Split>
    </Workspace>
  );
}

export const states = {
  kiosk: () => <VenueProgramme kiosk />,
  empty: () => <VenueProgramme empty />,
  failed: () => <VenueProgramme failed />,
};
