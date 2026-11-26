// Recipe: pairing a device. A QR code to scan, the code both devices show to compare, and the wait for the other device
// as a polite `Notice tone="warn"`; the section is a link target (`id`). Removing a device asks with
// `Dialog.confirm({ danger: true })`.
import { Bar, Button, CodeDisplay, Dialog, Notice, Pane, QrCode, Section, Text, Workspace } from "@k2b/ui/v2";

// An invented stand-in for a QR code, so the recipe draws without a library; an app passes `qr.toSvg(link)` from
// `@k2b/stdlib/qr`.
const finder = (x: number, y: number) =>
  `<rect x='${x}' y='${y}' width='7' height='7'/><rect x='${x + 1}' y='${y + 1}' width='5' height='5' fill='white'/><rect x='${x + 2}' y='${y + 2}' width='3' height='3'/>`;
const qrSvg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 25 25' shape-rendering='crispEdges'><rect width='25' height='25' fill='white'/>${finder(0, 0)}${finder(18, 0)}${finder(0, 18)}<rect x='9' y='9' width='2' height='2'/><rect x='12' y='10' width='3' height='1'/><rect x='10' y='13' width='1' height='4'/><rect x='14' y='14' width='4' height='2'/><rect x='19' y='19' width='3' height='3'/><rect x='9' y='20' width='4' height='1'/></svg>`;

type Props = { paired?: boolean };

export default function PairDevice(props: Props) {
  const remove = () =>
    void Dialog.confirm({
      title: "Tablet Werkstatt entfernen?",
      description: "Das Gerät meldet sich ab und muss neu gekoppelt werden.",
      confirm: "Entfernen",
      danger: true,
    });
  return (
    <Workspace head={<Bar start={<Text type="body">Geräte</Text>} />}>
      <Pane label="Geräte">
        <Section id="pair" icon="device-mobile" title="Gerät koppeln">
          {props.paired ? (
            <Text type="body">Das Tablet Werkstatt ist gekoppelt und kann jetzt Aufträge öffnen.</Text>
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
        <Bar
          end={
            <Button icon="trash" onClick={remove}>
              Gerät entfernen
            </Button>
          }
        />
      </Pane>
    </Workspace>
  );
}

// The states that Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  paired: () => <PairDevice paired />,
};
