import { createSettingsAPI } from "@k2b/cloud/services";

/** Storage and execution budgets, adjustable in Administration › Code and with `cld admin settings apply`; all sizes are UTF-8 bytes. */
export const CODE_SETTINGS = {
  "core.code.job_pending": {
    kind: "number",
    integer: true,
    min: 1,
    max: 10000,
    default: 100,
    label: "Pending check and test jobs",
    description: "Installation-wide queued and running authoring jobs; further requests return busy.",
    presentation: {
      translations: {
        de: {
          label: "Offene Prüf- und Testaufträge",
          description: "Installationsweite wartende und laufende Prüfaufträge; weitere Anfragen werden als ausgelastet abgewiesen.",
        },
      },
    },
  },
  "core.code.job_wait_ms": {
    kind: "number",
    integer: true,
    min: 1000,
    max: 120000,
    default: 30000,
    label: "Authoring job queue wait (ms)",
    description: "Queue allowance added to the isolated role execution budget.",
    presentation: {
      translations: {
        de: {
          label: "Wartebudget für Prüfaufträge (ms)",
          description: "Wartebudget zusätzlich zum Ausführungsbudget der isolierten Rolle.",
        },
      },
    },
  },
  "core.code.runner_job_slots": {
    kind: "number",
    integer: true,
    min: 1,
    max: 64,
    default: 1,
    label: "Authoring slots per runner",
    description: "Maximum simultaneous authoring roles per replica, within its shared slots and host memory/process allocation.",
    presentation: {
      translations: {
        de: {
          label: "Prüfplätze je Runner",
          description: "Maximale gleichzeitige Prüfrollen innerhalb der geteilten Plätze und der Speicher- und Prozessbudgets des Hosts.",
        },
      },
    },
  },
  "core.code.test_cases": {
    kind: "number",
    integer: true,
    min: 1,
    max: 1000,
    default: 64,
    label: "Cases per test job",
    description: "Maximum declarative fixtures in one isolated test job.",
    presentation: {
      translations: {
        de: { label: "Testfälle je Prüfauftrag", description: "Maximale deklarative Testfälle eines isolierten Prüfauftrags." },
      },
    },
  },
  "core.code.test_runs": {
    kind: "number",
    integer: true,
    min: 1,
    max: 1000,
    default: 200,
    label: "Invocations per test job",
    description: "Maximum fixture invocations across all cases of one test job.",
    presentation: {
      translations: {
        de: { label: "Ausführungen je Prüfauftrag", description: "Maximale Ausführungen über alle Testfälle eines Prüfauftrags." },
      },
    },
  },
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
  "core.code.automatic_attempts": {
    kind: "number",
    integer: true,
    min: 1,
    max: 10,
    default: 3,
    label: "Automatic attempts before an Action",
    description: "Maximum lease generations before the first Action; the original deadline still applies.",
    presentation: {
      translations: {
        de: {
          label: "Automatische Versuche vor einer Action",
          description: "Maximale Lease-Generationen vor der ersten Action; die ursprüngliche Frist gilt weiter.",
        },
      },
    },
  },
  "core.code.runner_slots": {
    kind: "number",
    integer: true,
    min: 1,
    max: 64,
    default: 4,
    label: "Slots per runner",
    description: "Maximum concurrent runs and authoring jobs advertised by one runner replica.",
    presentation: {
      translations: {
        de: { label: "Plätze je Runner", description: "Maximale gleichzeitige Läufe und Prüfaufträge einer Runner-Instanz." },
      },
    },
  },
  "core.code.runner_poll_ms": {
    kind: "number",
    integer: true,
    min: 1000,
    max: 60000,
    default: 20000,
    label: "Runner long poll (ms)",
    description: "Maximum duration of a signed acquisition request.",
    presentation: {
      translations: { de: { label: "Runner-Long-Poll (ms)", description: "Maximale Dauer einer signierten Arbeitsabholung." } },
    },
  },
  "core.code.runner_transport_ms": {
    kind: "number",
    integer: true,
    min: 1000,
    max: 60000,
    default: 30000,
    label: "Runner transport timeout (ms)",
    description: "Timeout for Core requests from the runner.",
    presentation: { translations: { de: { label: "Runner-Transportfrist (ms)", description: "Frist für Anfragen vom Runner an Core." } } },
  },
  "core.code.runner_retry_ms": {
    kind: "number",
    integer: true,
    min: 100,
    max: 30000,
    default: 1000,
    label: "Runner reconnect delay (ms)",
    description: "Delay before retrying a failed transport request.",
    presentation: {
      translations: { de: { label: "Runner-Wiederverbindung (ms)", description: "Wartezeit vor erneutem Verbindungsversuch." } },
    },
  },
  "core.code.runner_cache_bytes": {
    kind: "number",
    integer: true,
    min: 16777216,
    max: 268435456,
    default: 33554432,
    label: "Runner bundle cache (bytes)",
    description: "Maximum completed bundles held in memory per runner.",
    presentation: {
      translations: { de: { label: "Runner-Bundle-Cache (Bytes)", description: "Maximaler Speicher für vollständige Bundles je Runner." } },
    },
  },
  "core.code.runner_bridge_concurrency": {
    kind: "number",
    integer: true,
    min: 1,
    max: 32,
    default: 4,
    label: "Concurrent bridge calls per run",
    description: "Maximum simultaneous bridge calls from one run.",
    presentation: {
      translations: {
        de: { label: "Gleichzeitige Brückenaufrufe je Lauf", description: "Maximale gleichzeitige Brückenaufrufe eines Laufs." },
      },
    },
  },
  "core.code.runner_process_memory_bytes": {
    kind: "number",
    integer: true,
    min: 16777216,
    max: 536870912,
    default: 134217728,
    label: "Runner process memory (bytes)",
    description: "Memory budget per organization and trust tier process.",
    presentation: {
      translations: {
        de: { label: "Runner-Prozessspeicher (Bytes)", description: "Speicherbudget je Prozess einer Organisation und Vertrauensstufe." },
      },
    },
  },
} as const;

/** Typed access to Core-owned storage and execution settings. Core registers the definitions at startup. */
export const codeSettings = createSettingsAPI<typeof CODE_SETTINGS>();
