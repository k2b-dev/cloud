// Recipe: code to read and copy on an admin page. A private key as a secret (hidden until "Zeigen", copied and
// downloaded while hidden), a config with line numbers and a switch for long lines, a command, and a snippet with
// highlighting: each a CodeBlock in its Section. A copy says "Kopiert" in a toast. See `states` at the end: the key
// shown, and the worst case of a long log (2,000 lines, one of 10,000 signs) that shows 200 lines and "Alles zeigen".
import { Bar, Button, CodeBlock, Nav, Pane, Section, StatusRow, Text, Workspace } from "@k2b/ui/v2";

const key = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACDq3H4v0Qy2mZb8Jt0VqK7c1xYvLr3pA9sW2fE6nT4uHgAAAJjk2Lr85Ni6
/AAAAAtzc2gtZWQyNTUxOQAAACDq3H4v0Qy2mZb8Jt0VqK7c1xYvLr3pA9sW2fE6nT4uHg
AAAECb7xK2mQ0vR9tLwP4sYc8nF1zJ6hU3aE5dG7iK0oM2V+rcfi/RDLaZlvwm3RWorr
-----END OPENSSH PRIVATE KEY-----`;

const config = `# Gateway der Werkstatt Nord, erzeugt am 26.11.2026
CLOUD_URL=https://cloud.werkstatt-nord.example
CLOUD_GATEWAY_ID=gw_7Q2K94RTXM3D
CLOUD_GATEWAY_KEY_FILE=/etc/cloud/gateway_ed25519
CLOUD_ALLOWED_ORIGINS=https://cloud.werkstatt-nord.example,https://annahme.werkstatt-nord.example,https://lager.werkstatt-nord.example,https://werkstatt-nord.example
CLOUD_LOG_LEVEL=info`;

const command = "sudo cloud-gateway connect --config /etc/cloud/cloud.env --key /etc/cloud/gateway_ed25519";

const snippet = `import { createGateway } from "@k2b/cloud/gateway";

// Meldet das Gateway beim Start an und erneuert die Verbindung alle 30 Sekunden.
const gateway = createGateway({ configFile: "/etc/cloud/cloud.env", retry: 30_000 });
await gateway.connect();`;

/** A log of 2,000 lines, one of them 10,000 signs long: the worst case. */
export const longLog = Array.from({ length: 2000 }, (_, index) =>
  index === 41
    ? `2026-11-26T06:00:41Z warn  sync payload ${"x".repeat(10_000)}`
    : `2026-11-26T06:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z info  sync batch ${index + 1} done in ${(index % 17) + 3} ms`,
).join("\n");

type Props = { log?: boolean };

export default function GatewayAccess(props: Props) {
  return (
    <Workspace
      sidebar={
        <Nav
          title="Administration"
          icon="settings"
          groups={[
            {
              items: [
                { label: "Allgemein", icon: "adjustments" },
                { label: "Gateways", icon: "router", current: true, count: 3 },
                { label: "Dienste", icon: "server" },
                { label: "Protokoll", icon: "list-details" },
              ],
            },
          ]}
        />
      }
      head={
        <Bar
          start={<Text type="lead">Gateway Werkstatt Nord</Text>}
          end={
            <>
              <Button variant="ghost" icon="refresh" label="Schlüssel erneuern" />
              <Button variant="primary" icon="plug-connected">
                Verbindung prüfen
              </Button>
            </>
          }
        />
      }
      primary={{ label: "Verbindung prüfen", icon: "plug-connected" }}
    >
      <Pane
        label="Gateway Werkstatt Nord"
        status={
          <StatusRow
            lead="Verbunden seit 12. November"
            facts={[
              { value: "3", after: "Standorte" },
              { before: "Version", value: "0.71.2" },
            ]}
          />
        }
      >
        {props.log ? (
          <Section icon="list-details" title="Protokoll von heute" count={2000}>
            <CodeBlock label="gateway.log" code={longLog} lineNumbers wrap="toggle" download="gateway.log" />
          </Section>
        ) : (
          <>
            <Section icon="key" title="Privater Schlüssel" summary="Nur auf dem Gateway ablegen; wer ihn hat, spricht für das Gateway.">
              <CodeBlock label="gateway_ed25519" code={key} secret download="gateway_ed25519" />
            </Section>
            <Section icon="file-settings" title="Konfiguration">
              <CodeBlock label="cloud.env" code={config} lineNumbers wrap="toggle" download="cloud.env" />
            </Section>
            <Section icon="terminal-2" title="Einrichten" summary="Auf dem Gateway als Administrator ausführen.">
              <CodeBlock label="Befehl zum Verbinden" code={command} />
            </Section>
            <Section icon="code" title="Aus einer App anbinden">
              <CodeBlock label="gateway.ts" code={snippet} language="ts" lineNumbers />
            </Section>
          </>
        )}
      </Pane>
    </Workspace>
  );
}

// The states Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  shown: { render: () => <GatewayAccess />, press: "Zeigen" },
  log: () => <GatewayAccess log />,
};
