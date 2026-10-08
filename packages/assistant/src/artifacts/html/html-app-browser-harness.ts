// Test page for HTML app mounts: the real composer, prelude and host, with in-memory services.
import { CloudError } from "../runtime/errors";
import type { AppFrameAssets } from "./assets";
import type { AppFiles } from "./compose";
import { type Mount, type MountEvent, mountApp } from "./host";

type Harness = {
  mount(files: AppFiles, options?: { hash?: string; answers?: boolean[]; download?: "capture" | "save" }): void;
  stop(): void;
  events: MountEvent[];
  downloads: { name: string; size: number; type: string; text: string }[];
  opened: string[];
  calls: string[];
  hash?: string;
  inert(): boolean;
  snapshot(): Promise<string>;
  hashToApp(value: string): void;
};
declare global {
  var harness: Harness;
  var assets: AppFrameAssets;
}

const kv = new Map<string, unknown>();
let mount: Mount | undefined;
globalThis.harness = {
  events: [],
  downloads: [],
  opened: [],
  calls: [],
  mount(files, options = {}) {
    const answers = [...(options.answers ?? [])];
    const answer = () => new Promise<boolean>((resolve) => setTimeout(() => resolve(answers.shift() ?? false), 200));
    mount = mountApp(document.querySelector("main")!, files, {
      ...globalThis.assets,
      context: { locale: "de-DE", timeZone: "Europe/Berlin", user: { id: "u1", name: "Łukasz Öztürk" } },
      title: "Test app",
      hash: options.hash,
      services: (confirm) => ({
        chunk: async (name) => {
          globalThis.harness.calls.push(`chunk:${name}`);
          return (await fetch(`/chunks/${name}`)).text();
        },
        storage: async (request) => {
          globalThis.harness.calls.push(`storage:${request.operation}:${request.key ?? ""}`);
          if (request.operation === "write") kv.set(request.key!, request.value);
          if (request.operation === "read") {
            // A slow read shows that `ready` waits for pending cloud.* calls.
            await new Promise((resolve) => setTimeout(resolve, 300));
            return kv.get(request.key!) ?? null;
          }
          return null;
        },
        capability: async (name) => {
          globalThis.harness.calls.push(`capability:${name}`);
          if (!(await confirm(answer, (ok) => ok))) throw new CloudError("denied", "Declined");
          return { data: { ok: true } };
        },
      }),
      confirmOpen: async (url) => {
        globalThis.harness.opened.push(url);
        return answer();
      },
      onEvent: (event) => globalThis.harness.events.push(event),
      onHash: (hash) => {
        globalThis.harness.hash = hash;
      },
      onDownload:
        options.download === "save"
          ? undefined
          : async (name, blob) => {
              globalThis.harness.downloads.push({ name, size: blob.size, type: blob.type, text: await blob.text() });
            },
    });
  },
  stop: () => mount?.stop(),
  inert: () => !!mount?.frame.inert,
  snapshot: () => mount!.snapshot(),
  hashToApp: (value) => mount?.hash(value),
};
