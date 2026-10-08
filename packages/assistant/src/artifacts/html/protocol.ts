// Messages between a Cloud page that mounts an HTML app and the app frame's prelude.
import type { RuntimeContext } from "../runtime/cloud";

/** Embedded by the composer as JSON and read once by the prelude. */
export type FrameConfig = {
  context: RuntimeContext;
  /** Initial `location.hash`, mirrored from the host URL. */
  hash: string;
  /** App JavaScript modules by path; `entries` load in this order. */
  modules: Record<string, string>;
  entries: string[];
  /** Upper bound for waiting on pending `cloud.*` calls before `ready`. */
  readyBudgetMs: number;
};

export type FrameLogLevel = "log" | "info" | "warn" | "error";

/** Untrusted: the host validates every field before it acts on one. */
export type FrameToHost =
  | { type: "rpc"; id: number; method: string; args: unknown[] }
  | { type: "cancel"; id: number }
  | { type: "log"; level: FrameLogLevel; text: string }
  | { type: "error"; text: string; where?: string }
  /** An unhandled `cloud.*` failure; only its code, since Cloud never shows text the app supplies. */
  | { type: "notice"; code: string }
  | { type: "ready"; height: number }
  | { type: "hash"; value: string }
  | { type: "open"; url: string }
  | { type: "snapshot"; id: number; html: string };

export type HostToFrame =
  | { type: "result"; id: number; value?: unknown; error?: string; code?: string }
  | { type: "theme"; value: "light" | "dark" }
  | { type: "hash"; value: string }
  /** Asks for the current document, which the host sanitizes into a static copy. */
  | { type: "snapshot"; id: number };

/** `cloud.*` methods an app frame may call. The host binds app, viewer and data scope from the mount, never from arguments. */
export const FRAME_METHODS: ReadonlySet<string> = new Set([
  "runtime.chunk",
  "storage",
  "database",
  "pdf",
  "ai",
  "http.fetch",
  "capabilities.run",
  "capabilities.stream",
  "file.save",
]);
