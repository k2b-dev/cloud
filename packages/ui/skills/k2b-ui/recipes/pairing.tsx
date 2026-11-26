// Recipe: pairing a device. The paired devices stand as rows with the mark of their kind, their person and when they
// were last seen; beside them a QR code to scan, the code both devices show to compare, and the wait for the other
// device as a polite `Notice tone="warn"`; the section is a link target (`id`). Removing a device asks with
// `Dialog.confirm({ danger: true })`.
import {
  Bar,
  Button,
  Chip,
  CodeDisplay,
  Dialog,
  List,
  Nav,
  Notice,
  Pane,
  Path,
  QrCode,
  Row,
  Section,
  StatusRow,
  Text,
  Workspace,
} from "@k2b/ui/v2";

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { name: "Verwaltung", color: "#2563eb", icon: "adjustments-horizontal" };

// An invented stand-in for a QR code, so the recipe draws without a library; an app passes `qr.toSvg(link)` from
// `@k2b/stdlib/qr`.
const finder = (x: number, y: number) =>
  `<rect x='${x}' y='${y}' width='7' height='7'/><rect x='${x + 1}' y='${y + 1}' width='5' height='5' fill='white'/><rect x='${x + 2}' y='${y + 2}' width='3' height='3'/>`;
const qrSvg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 25 25' shape-rendering='crispEdges'><rect width='25' height='25' fill='white'/>${finder(0, 0)}${finder(18, 0)}${finder(0, 18)}<rect x='9' y='9' width='2' height='2'/><rect x='12' y='10' width='3' height='1'/><rect x='10' y='13' width='1' height='4'/><rect x='14' y='14' width='4' height='2'/><rect x='19' y='19' width='3' height='3'/><rect x='9' y='20' width='4' height='1'/></svg>`;

// One mark per kind of device, the same in the list and every sentence.
const kind = {
  tablet: { icon: "device-tablet", color: "#0e7490" },
  phone: { icon: "device-mobile", color: "#7c3aed" },
  laptop: { icon: "device-laptop", color: "#2563eb" },
  terminal: { icon: "device-desktop", color: "#c2410c" },
};

type Device = { id: string; name: string; kind: keyof typeof kind; person: string; seen: string; stale?: boolean };

const devices: Device[] = [
  { id: "d1", name: "Tablet Werkstatt", kind: "tablet", person: "Felix Thal", seen: "gerade aktiv" },
  { id: "d2", name: "iPhone Mira", kind: "phone", person: "Mira Solberg", seen: "vor 4 Min" },
  { id: "d3", name: "Laptop Büro", kind: "laptop", person: "Ada Renz", seen: "vor 1 Std" },
  { id: "d4", name: "Terminal Halle 1", kind: "terminal", person: "für alle", seen: "heute, 07:02" },
  { id: "d5", name: "Pixel Sami", kind: "phone", person: "Sami Yilmaz", seen: "gestern" },
  { id: "d6", name: "Tablet Montage", kind: "tablet", person: "Jonas Kern", seen: "vor 41 Tagen", stale: true },
];
const fresh: Device = { id: "d7", name: "Tablet Lager", kind: "tablet", person: "Sami Yilmaz", seen: "gerade gekoppelt" };

type Props = { paired?: boolean };

export default function PairDevice(props: Props) {
  const list = () => (props.paired ? [fresh, ...devices] : devices);
  const remove = (device: Device) =>
    void Dialog.confirm({
      title: `${device.name} entfernen?`,
      description: "Das Gerät meldet sich ab und muss neu gekoppelt werden.",
      confirm: "Entfernen",
      danger: true,
    });
  return (
    <Workspace
      sidebar={
        <Nav
          title="Verwaltung"
          icon="adjustments-horizontal"
          groups={[
            {
              items: [
                { label: "Übersicht", icon: "layout-dashboard", href: "#uebersicht" },
                { label: "Apps", icon: "apps", count: 14, href: "#apps" },
                { label: "Anmeldung", icon: "login", href: "#anmeldung" },
                { label: "Geräte", icon: "devices", count: list().length, current: true },
                { label: "Speicher", icon: "database", href: "#speicher" },
                { label: "Ausgehende Mail", icon: "mail-forward", dot: "bad", href: "#mail" },
              ],
            },
          ]}
        />
      }
      head={<Bar start={<Path label="Ort" items={[{ label: "Anmeldung", href: "#anmeldung" }, { label: "Geräte" }]} />} />}
    >
      <Pane
        label="Geräte"
        status={
          <StatusRow
            lead={props.paired ? "7 Geräte gekoppelt" : "6 Geräte gekoppelt"}
            facts={[{ value: 5, after: "heute aktiv" }]}
            filters={<Chip status="warn">1 seit 41 Tagen still</Chip>}
          />
        }
      >
        <Pane.Split>
          <Pane label="Gekoppelte Geräte">
            <List label="Gekoppelte Geräte">
              {list().map((device) => (
                <Row
                  mark={kind[device.kind]}
                  lines={[device.name, `${device.person} · ${device.seen}`]}
                  marks={
                    device.stale ? <Chip status="warn">Still</Chip> : device.id === fresh.id ? <Chip status="ok">Neu</Chip> : undefined
                  }
                  // a deed that destroys asks first, in red (see `remove`)
                  end={<Button variant="ghost" icon="trash" label={`${device.name} entfernen`} onClick={() => remove(device)} />}
                />
              ))}
            </List>
          </Pane>
          <Pane side label="Gerät koppeln" width={{ min: 300, default: 360 }}>
            <Section id="pair" icon="device-mobile" title="Gerät koppeln">
              {props.paired ? (
                <Notice tone="note" icon="circle-check" title="Gekoppelt">
                  Das Tablet Lager ist gekoppelt und kann jetzt Aufträge öffnen.
                </Notice>
              ) : (
                <>
                  <Text type="body">Öffne die App auf dem Gerät und scanne den Code.</Text>
                  <QrCode svg={qrSvg} label="QR-Code zum Koppeln" />
                  <Text type="body">Steht auf beiden Geräten dieselbe Zahl?</Text>
                  <CodeDisplay value="482 913" label="Vergleichscode" />
                </>
              )}
            </Section>
            {!props.paired && (
              <Notice tone="warn" title="Wartet auf das Gerät">
                Sobald das Gerät den Code bestätigt, ist es gekoppelt. Der Code gilt fünf Minuten.
              </Notice>
            )}
          </Pane>
        </Pane.Split>
      </Pane>
    </Workspace>
  );
}

// The states that Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  paired: () => <PairDevice paired />,
};
