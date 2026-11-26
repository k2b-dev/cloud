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
import { For, Show } from "solid-js";

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
  {
    title: "Podium: Wohnen im Quartier",
    kind: "talk",
    time: "So 16:00",
    room: "Großer Saal",
    seats: { free: 44, of: 120 },
    host: { name: "Olena Koval", color: "#15803d" },
  },
];

/** What the wall screen shows after what runs now. */
const next = [...today.slice(1), ...week.slice(0, 2)];

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

type Listed = Event & { day: "Heute" | "Diese Woche"; key: string };
const listed = (events: Event[], day: Listed["day"]): Listed[] => events.map((event, index) => ({ ...event, day, key: `${day}-${index}` }));
const taken = (seats: Seats) => seats.of - seats.free;

/**
 * The programme as one table grouped by day: the event with when and where, its type as a tag in its colour, who
 * hosts it, how full it is as a meter, and its state. On the phone each event is one row of two lines with its state.
 */
const programme = (events: Listed[]) => (
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
        width: { min: 240, default: 340, fixed: true },
        cell: (event) => ({ lines: [event.title, `${event.time} · ${event.room}`] }),
      },
      {
        title: "Art",
        width: { min: 100, default: 112, fixed: true },
        drop: true,
        cell: (event) => (
          <Chip tag color={kinds[event.kind].color} icon={kinds[event.kind].icon}>
            {kinds[event.kind].label}
          </Chip>
        ),
      },
      {
        title: "Leitung",
        width: { min: 64, default: 72, fixed: true },
        drop: true,
        cell: (event) => <Avatar name={event.host.name} color={event.host.color} />,
      },
      {
        title: "Belegt",
        width: { min: 172, default: 196, fixed: true },
        drop: true,
        cell: (event) => <Progress value={taken(event.seats)} of={event.seats.of} label={`${taken(event.seats)}/${event.seats.of}`} />,
      },
      { title: "Plätze", align: "end", cell: (event) => seatsChip(event.seats) },
    ]}
    phone={(event) => ({
      lines: [event.title, `${event.time} · ${event.room} · ${kinds[event.kind].label}`],
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
  const full = () => events().filter((event) => event.seats.free === 0).length;
  const almost = () => events().filter((event) => few(event.seats)).length;
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
                  <Text weight="strong">{props.kiosk ? "Jetzt: Offene Holzwerkstatt · Werkraum" : `Heute ${events().length}`}</Text>
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
            {programme([...listed(events(), "Heute"), ...listed(week, "Diese Woche")])}
          </Show>
        </Pane>
        <Pane side label="Ihr Besuch" width={{ min: 280, default: 360, fixed: true }}>
          <Section icon="armchair" color={brand.color} title="Plätze heute">
            <Row
              icon="armchair"
              color={brand.color}
              lines={[`${free()} von ${seats()} frei`, "über alle Veranstaltungen"]}
              end={<Progress value={seats() - free()} of={seats() || 1} label={`${seats() - free()}/${seats()}`} />}
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
          <Section icon="building" color={brand.color} title="Säle">
            <Row
              icon="building"
              color={brand.color}
              lines={["Großer Saal", "Kammermusik · 120 Plätze"]}
              end={<Progress value={120} of={120} label="120/120" />}
            />
            <Row
              icon="building"
              color={brand.color}
              lines={["Saal 2", "Stadtgeschichten · 40 Plätze"]}
              end={<Progress value={28} of={40} label="28/40" />}
            />
            <Row
              icon="building"
              color={brand.color}
              lines={["Werkraum", "Holzwerkstatt · 12 Plätze"]}
              end={<Progress value={9} of={12} label="9/12" />}
            />
          </Section>
          <Show when={props.kiosk}>
            <Section icon="clock" color={brand.color} title="Als Nächstes">
              <For each={next}>
                {(event) => <Row avatar={event.host} lines={[event.title, `${event.time} · ${event.room}`]} end={seatsChip(event.seats)} />}
              </For>
            </Section>
          </Show>
          <Show when={!props.kiosk}>
            <Notice tone="note" icon="wheelchair" title="Barrierefrei">
              Alle Säle sind stufenlos über den Hof erreichbar. Eine Höranlage gibt es im Großen Saal.
            </Notice>
          </Show>
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
