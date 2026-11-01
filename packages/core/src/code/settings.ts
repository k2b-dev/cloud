import { createSettingsAPI } from "@k2b/cloud/services";

/** Core-owned storage admission budgets, adjustable with `cld admin settings apply`; all sizes are UTF-8 bytes. */
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
    default: 1000,
    label: "Capability calls per run",
    description: "Maximum number of recorded capability calls in one attempt.",
    presentation: {
      translations: {
        de: { label: "Capability-Aufrufe je Lauf", description: "Maximale Anzahl gespeicherter Capability-Aufrufe in einem Versuch." },
      },
    },
  },
} as const;

/** Typed access to Core-owned storage admission settings. Core registers the definitions at startup. */
export const codeSettings = createSettingsAPI<typeof CODE_SETTINGS>();
