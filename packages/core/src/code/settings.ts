import { createSettingsAPI } from "@k2b/cloud/services";

/** Storage admission budgets, adjustable in Administration › Code; all sizes are UTF-8 bytes. */
export const CODE_SETTINGS = {
  "core.code.source_bytes": {
    kind: "number",
    integer: true,
    min: 1,
    max: 16_777_216,
    default: 1_048_576,
    label: "Source bytes per version",
    description: "Maximum total source path and content bytes in one immutable version.",
  },
  "core.code.source_files": {
    kind: "number",
    integer: true,
    min: 1,
    max: 100,
    default: 100,
    label: "Source files per version",
    description: "Maximum source files in one version; the metadata must fit the capability result budget.",
  },
  "core.code.bundle_bytes": {
    kind: "number",
    integer: true,
    min: 1,
    max: 16_777_216,
    default: 4_194_304,
    label: "Bundle bytes per version",
    description: "Maximum UTF-8 bytes of the exact runner bundle.",
  },
  "core.code.manifest_bytes": {
    kind: "number",
    integer: true,
    min: 1,
    max: 4_194_304,
    default: 1_048_576,
    label: "Manifest bytes per version",
    description: "Maximum JSON bytes of the checked version manifest.",
  },
  "core.code.payload_bytes": {
    kind: "number",
    integer: true,
    min: 1,
    max: 32_768,
    default: 32_768,
    label: "Run and call payload bytes",
    description: "Maximum bytes of each run input/output or complete capability call/result pair. The transport bounds the maximum.",
  },
  "core.code.calls_per_run": {
    kind: "number",
    integer: true,
    min: 1,
    max: 1_000_000,
    default: 1000,
    label: "Capability calls per run",
    description: "Maximum number of recorded capability calls in one attempt.",
  },
} as const;

/** Typed access to Core-owned storage admission settings. Core registers the definitions at startup. */
export const codeSettings = createSettingsAPI<typeof CODE_SETTINGS>();
