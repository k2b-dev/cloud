import { createSettingsAPI } from "@k2b/cloud/services";

/** Storage and execution budgets, adjustable in Administration › Code and with `cld admin settings apply`; all sizes are UTF-8 bytes. */
export const CODE_SETTINGS = {
  "core.code.source_bytes": {
    kind: "number",
    integer: true,
    min: 1,
    max: 16_777_216,
    default: 1_048_576,
    label: "Source bytes per version",
    description: "Maximum total source path and content bytes in one immutable version.",
    presentation: {
      translations: {
        de: {
          label: "Quelldaten je Version (Bytes)",
          description: "Maximale UTF-8-Bytes der Quellpfade und Inhalte einer unveränderlichen Version.",
        },
      },
    },
  },
  "core.code.source_files": {
    kind: "number",
    integer: true,
    min: 1,
    max: 100,
    default: 100,
    label: "Source files per version",
    description: "Maximum source files in one version; the metadata must fit the capability result budget.",
    presentation: {
      translations: {
        de: {
          label: "Quelldateien je Version",
          description: "Maximale Dateianzahl je Version; die Metadaten müssen in das Capability-Ergebnis passen.",
        },
      },
    },
  },
  "core.code.bundle_bytes": {
    kind: "number",
    integer: true,
    min: 1,
    max: 16_777_216,
    default: 4_194_304,
    label: "Bundle bytes per version",
    description: "Maximum UTF-8 bytes of the exact runner bundle.",
    presentation: {
      translations: { de: { label: "Bundle je Version (Bytes)", description: "Maximale UTF-8-Bytes des vollständigen Runner-Bundles." } },
    },
  },
  "core.code.manifest_bytes": {
    kind: "number",
    integer: true,
    min: 1,
    max: 4_194_304,
    default: 1_048_576,
    label: "Manifest bytes per version",
    description: "Maximum JSON bytes of the checked version manifest.",
    presentation: {
      translations: { de: { label: "Manifest je Version (Bytes)", description: "Maximale JSON-Bytes des geprüften Versionsmanifests." } },
    },
  },
  "core.code.payload_bytes": {
    kind: "number",
    integer: true,
    min: 1,
    max: 32_768,
    default: 32_768,
    label: "Run and call input bytes",
    description:
      "Maximum jsonb text bytes of each run input or normalized capability call before invocation. Results retain the public capability result budget.",
    presentation: {
      translations: {
        de: {
          label: "Lauf- und Aufrufeingaben (Bytes)",
          description:
            "Maximale jsonb-Textbytes je Laufeingabe oder normalisiertem Aufruf vor der Ausführung. Ergebnisse behalten das öffentliche Capability-Ergebnisbudget.",
        },
      },
    },
  },
  "core.code.calls_per_run": {
    kind: "number",
    integer: true,
    min: 1,
    max: 1000,
    default: 200,
    label: "Bridge calls per run",
    description: "Maximum bridge calls in one attempt, including recorded capability calls.",
    presentation: {
      translations: {
        de: {
          label: "Brückenaufrufe je Lauf",
          description: "Maximale Brückenaufrufe je Versuch, einschließlich gespeicherter Capability-Aufrufe.",
        },
      },
    },
  },
  "core.code.calls_per_second": {
    kind: "number",
    integer: true,
    min: 1,
    max: 1000,
    default: 60,
    label: "Bridge calls per second per Code",
    description:
      "Shared Valkey call rate per Code across all runners and Core instances; at most the full per-run call ceiling per second.",
    presentation: {
      translations: {
        de: {
          label: "Brückenaufrufe je Sekunde und Code",
          description:
            "Gemeinsame Valkey-Aufrufrate je Code über alle Runner und Core-Instanzen; höchstens das vollständige Aufruflimit eines Laufs je Sekunde.",
        },
      },
    },
  },
  "core.code.wall_clock_ms": {
    kind: "number",
    integer: true,
    min: 1,
    max: 300000,
    default: 300000,
    label: "Wall clock per run (ms)",
    description: "Maximum elapsed time of one Code attempt.",
    presentation: {
      translations: { de: { label: "Wanduhr je Lauf (ms)", description: "Maximale verstrichene Zeit eines Code-Versuchs." } },
    },
  },
  "core.code.database_bytes": {
    kind: "number",
    integer: true,
    min: 1,
    max: 1073741824,
    default: 104857600,
    label: "Database bytes per Code",
    description: "Maximum size of the lazily created Code database.",
    presentation: {
      translations: { de: { label: "Datenbank je Code (Bytes)", description: "Maximale Größe der bei Bedarf angelegten Code-Datenbank." } },
    },
  },
  "core.code.ai_budget_usd": {
    kind: "number",
    min: 0,
    max: 100,
    default: 1,
    label: "AI reference budget per run (USD)",
    description: "Maximum AI reference cost of one Code attempt; zero disables AI.",
    presentation: {
      translations: {
        de: { label: "KI-Referenzbudget je Lauf (USD)", description: "Maximale KI-Referenzkosten je Code-Versuch; 0 sperrt KI." },
      },
    },
  },
  "core.code.concurrency_per_code": {
    kind: "number",
    integer: true,
    min: 1,
    max: 100,
    default: 1,
    label: "Concurrent runs per Code",
    description: "Maximum simultaneous attempts for one Code.",
    presentation: {
      translations: { de: { label: "Gleichzeitige Läufe je Code", description: "Maximale Anzahl gleichzeitiger Versuche eines Codes." } },
    },
  },
  "core.code.concurrency_per_owner": {
    kind: "number",
    integer: true,
    min: 1,
    max: 1000,
    default: 10,
    label: "Concurrent runs per owner",
    description: "Maximum simultaneous attempts across all Code of one exact owner.",
    presentation: {
      translations: {
        de: {
          label: "Gleichzeitige Läufe je Besitzer",
          description: "Maximale Anzahl gleichzeitiger Versuche aller Codes eines genauen Besitzers.",
        },
      },
    },
  },
} as const;

/** Typed access to Core-owned storage and execution settings. Core registers the definitions at startup. */
export const codeSettings = createSettingsAPI<typeof CODE_SETTINGS>();
