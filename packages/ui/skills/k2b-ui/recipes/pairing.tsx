// Recipe: pairing a device. The paired devices stand as rows with the mark of their kind, their person and when they
// were last seen; beside them a QR code to scan, the code both devices show to compare, and the wait for the other
// device as a polite `Notice tone="warn"`; the section is a link target (`id`). Removing a device asks with
// `Dialog.confirm({ danger: true })`.

import { qr } from "@k2b/stdlib/qr";
import {
  Bar,
  Button,
  Chip,
  CodeDisplay,
  Dialog,
  Digest,
  Mark,
  Nav,
  Notice,
  Pane,
  Path,
  QrCode,
  Section,
  StatusRow,
  Table,
  Text,
  Workspace,
} from "@k2b/ui/v2";

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { name: "Verwaltung", color: "#2563eb", icon: "adjustments-horizontal" };

// The QR code the app makes from the pairing link with `@k2b/stdlib/qr`.
const qrSvg = qr.toSvg("https://cloud.werkstatt.example/koppeln?code=482913");

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
            {/* one line per device: its kind, its person, when it was last seen, its state and the deed */}
            <Table
              label="Gekoppelte Geräte"
              rows={list()}
              rowKey={(device) => device.id}
              phone={(device) => ({
                mark: kind[device.kind],
                lines: [device.name, `${device.person} · ${device.seen}`],
                marks: device.stale ? <Chip status="warn">Still</Chip> : device.id === fresh.id ? <Chip status="ok">Neu</Chip> : undefined,
              })}
              columns={[
                { title: "Gerät", width: { min: 150, default: 250 }, mark: (device) => kind[device.kind], cell: (device) => device.name },
                {
                  title: "Person",
                  width: { min: 120, default: 200 },
                  drop: true,
                  avatar: (device) => ({ name: device.person === "für alle" ? "Alle" : device.person }),
                  cell: (device) => device.person,
                },
                { title: "Zuletzt", width: { min: 100, default: 160 }, cell: (device) => device.seen },
                {
                  title: "Zustand",
                  width: { min: 90, default: 130 },
                  cell: (device) =>
                    device.stale ? (
                      <Chip status="warn">Still</Chip>
                    ) : device.id === fresh.id ? (
                      <Chip status="ok">Neu</Chip>
                    ) : (
                      <Chip status="ok">Aktiv</Chip>
                    ),
                },
                {
                  title: "Entfernen",
                  width: { min: 56, default: 80 },
                  align: "end",
                  // a deed that destroys asks first, in red (see `remove`)
                  cell: (device) => (
                    <Button variant="ghost" icon="trash" label={`${device.name} entfernen`} onClick={() => remove(device)} />
                  ),
                },
              ]}
            />
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
            <Section icon="history" title="Zuletzt gekoppelt">
              <Digest
                label="Zuletzt gekoppelt"
                activity={[
                  {
                    person: { name: "Sami Yilmaz" },
                    text: (
                      <>
                        <Text weight="strong">Sami Yilmaz</Text> hat <Mark {...kind.phone} />
                        <Text weight="strong">Pixel Sami</Text> gekoppelt
                      </>
                    ),
                    time: "gestern",
                  },
                  {
                    person: { name: "Ada Renz" },
                    text: (
                      <>
                        <Text weight="strong">Ada Renz</Text> hat <Mark {...kind.laptop} />
                        <Text weight="strong">Laptop Büro</Text> gekoppelt
                      </>
                    ),
                    time: "Mo.",
                  },
                ]}
              />
            </Section>
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
