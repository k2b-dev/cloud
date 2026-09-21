# Pulse scripts

Acceptance probes for the production acceptance report. `DATABASE_URL` must target the disposable loopback `pulse_load_test` database; fixture files hold credentials and stay outside Git.

- `http-load.ts` — HTTP ingest and query probe against a running isolated Pulse app: `bun packages/pulse/scripts/http-load.ts --fixture /tmp/pulse-fixture.json --rounds 3`
- `volume-fixture.ts` — prepares 30 days of accumulated SQL volume: `bun packages/pulse/scripts/volume-fixture.ts --fixture /tmp/pulse-fixture.json --output /tmp/pulse-volume.json`
- `volume-http-probe.ts` — read-only HTTP queries against the completed volume fixture: `bun packages/pulse/scripts/volume-http-probe.ts --fixture /tmp/pulse-fixture.json --metadata /tmp/pulse-volume.json`
