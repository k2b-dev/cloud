import { render } from "solid-js/web";
import { Bar, Cells, Chip, Facts, Pane, Section, Table, Text, Workspace } from "../src/v2";

// A client of the sign-in service, as an admin page draws it: three key figures, its addresses read sign by sign, its
// keys with their fingerprints, and what happened lately. The values are long on purpose, as real redirect addresses
// are; the test reads where they break and how the figures stand.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const keys = [
  { name: "Signatur 2026", fingerprint: "SHA256:7f3a0c9e51d24b8f9a6e0c1d2e3f4a5b6c7d8e9f", created: "12.11.2026" },
  { name: "Signatur 2025", fingerprint: "SHA256:0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c", created: "03.10.2025" },
];
const events = [
  { what: "Anmeldung von Ada Renz", when: "Heute, 09:14", from: "Werkstatt Nord" },
  { what: "Neuer Schlüssel angelegt", when: "12.11.2026", from: "Verwaltung" },
];
const uris = [
  "https://grafana.werkstatt-nord.example.org/login/generic_oauth/callback?tenant=werkstatt-nord&state=return",
  "https://monitoring.example.org/oauth2/authorization/cloud-werkstatt/callback",
];

const root = document.getElementById("root");
if (!root) throw new Error("technical-values: #root is missing");
render(
  () => (
    <Workspace head={<Bar start={<Text type="lead">Grafana</Text>} />}>
      <Pane label="Grafana">
        <Cells>
          <Cells.Cell icon="login" label="Anmeldungen heute" value="128" meta="gestern 117" />
          <Cells.Cell icon="users" label="Aktive Sitzungen" value="42" />
          <Cells.Cell icon="clock" label="Letzte Anmeldung" value="09:14" meta="Ada Renz" />
        </Cells>
        <Pane.Split>
          <Pane label="Überblick">
            <Section title="Schlüssel">
              <Table
                label="Schlüssel"
                rows={keys}
                phone={(row) => ({ lines: [row.name, row.fingerprint] })}
                columns={[
                  { title: "Name", width: { min: 140, default: 160 }, cell: (row) => row.name },
                  { title: "Fingerabdruck", width: { min: 200, default: 260 }, mono: true, cell: (row) => row.fingerprint },
                  { title: "Angelegt", width: { min: 100, default: 110 }, cell: (row) => row.created, drop: true },
                ]}
              />
            </Section>
            <Section title="Zuletzt">
              <Table
                label="Ereignisse"
                rows={events}
                phone={(row) => ({ lines: [row.what, `${row.when} · ${row.from}`] })}
                columns={[
                  { title: "Was", width: { min: 160, default: 220 }, cell: (row) => row.what },
                  { title: "Wann", width: { min: 100, default: 140 }, cell: (row) => row.when },
                  { title: "Von", width: { min: 120, default: 140 }, cell: (row) => row.from, drop: true },
                ]}
              />
            </Section>
            <Section title="Freigegebene Adressen">
              <Table label="Adressen" rows={uris} columns={[{ title: "Adresse", mono: true, cell: (uri) => uri }]} />
            </Section>
          </Pane>
          <Pane side label="Angaben" width={{ min: 280, default: 360 }}>
            <Section title="Zugang">
              <Facts
                items={[
                  { label: "Client-ID", value: "cl_grafana_7Q2K94RTXM3D", mono: true, copy: "cl_grafana_7Q2K94RTXM3D" },
                  ...uris.map((uri, index) => ({ label: index === 0 ? "Redirect-URIs" : "", value: uri, mono: true, copy: uri })),
                  { label: "Zugriff", value: <Chip status="ok">Alle Personen</Chip> },
                ]}
              />
            </Section>
          </Pane>
        </Pane.Split>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
