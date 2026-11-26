import { render } from "solid-js/web";
import { longLog } from "../skills/k2b-ui/recipes/code";
import { LocaleProvider } from "../src/intl/locale";
import { Bar, CodeBlock, Pane, Section, Text, Workspace } from "../src/v2";

// CodeBlock at its worst on a v2 screen: a secret key, a config with a long line and a switch for it, and a log of
// 2,000 lines with one of 10,000 signs (the recipe's worst case). The words of the library in German, as in Cloud.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

export const secretKey = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
-----END OPENSSH PRIVATE KEY-----`;

const root = document.getElementById("root");
if (!root) throw new Error("code: #root is missing");
render(
  () => (
    <LocaleProvider locale="de">
      <Workspace head={<Bar start={<Text type="lead">Gateway Werkstatt Nord</Text>} />}>
        <Pane label="Gateway Werkstatt Nord">
          <Section icon="key" title="Privater Schlüssel">
            <CodeBlock label="gateway_ed25519" code={secretKey} secret download="gateway_ed25519" />
          </Section>
          <Section icon="file-settings" title="Konfiguration">
            <CodeBlock
              label="cloud.env"
              code={`CLOUD_URL=https://cloud.werkstatt-nord.example\nCLOUD_ALLOWED_ORIGINS=${"https://lager.werkstatt-nord.example,".repeat(12)}`}
              lineNumbers
              wrap="toggle"
            />
          </Section>
          <Section icon="list-details" title="Protokoll von heute">
            <CodeBlock label="gateway.log" code={longLog} lineNumbers />
          </Section>
        </Pane>
      </Workspace>
    </LocaleProvider>
  ),
  root,
);
window.__k2Mounted = true;
