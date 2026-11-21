import { z } from "zod";

// Opaque, not an Id: 1,024 UTF-16 units allow up to 4 KiB of UTF-8 per token.
// This local metadata budget leaves ample room beyond Stalwart's short states
// without letting a provider grow persisted checkpoints without a bound.
// The account checkpoint that stores these states is in jmap-account-state.ts: it needs the scan
// step of jmap-scan.ts, which imports this schema, so this module stays free of imports.
export const jmapStateSchema = z.string().max(1_024);
