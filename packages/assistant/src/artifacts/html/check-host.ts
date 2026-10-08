// Browser half of code_check: composes and mounts through the existing host.
import { artifactClient } from "../client";
import type { ArtifactSource } from "../contracts";
import type { RuntimeContext } from "../runtime/cloud";
import { CloudError, cloudError } from "../runtime/errors";
import { sharedStorage } from "../runtime/shared-storage";
import type { AppFrameAssets } from "./assets";
import { CHECK_LIMITS, CHECK_UNAVAILABLE } from "./check-contracts";
import type { CheckCommand } from "./check-realm";
import { type Mount, type MountEvent, mountApp } from "./host";

export type CheckState = { events: MountEvent[]; lint: Mount["lint"]; ready: boolean };
declare global {
  interface Window {
    assistantCheckMount: (input: {
      source: ArtifactSource;
      scopeId: string;
      artifactId?: string;
      context: RuntimeContext;
      assets: AppFrameAssets;
      conversationId: string;
      theme: "light" | "dark";
    }) => void;
    assistantCheckInspect: (input: CheckCommand) => Promise<unknown>;
    assistantCheckState: () => CheckState;
    assistantCheckStop: () => void;
    assistantCheckDownload: (name: string, data: string, type: string) => Promise<void>;
  }
}
let mounted: Mount | undefined;
let state: CheckState;
let hash = "",
  downloadCount = 0,
  outputBytes = 0;
let downloadQueue = Promise.resolve();
window.assistantCheckMount = (input) => {
  mounted?.stop();
  // Mobile Chromium otherwise gives this host a 980px layout viewport,
  // which also widens both nested frames despite the 390px device viewport.
  let viewport = document.querySelector('meta[name="viewport"]');
  if (!viewport) {
    viewport = document.createElement("meta");
    viewport.setAttribute("name", "viewport");
    document.head.append(viewport);
  }
  viewport.setAttribute("content", "width=device-width,initial-scale=1");
  document.documentElement.className = input.theme;
  document.body.style.cssText = "margin:0;height:100vh";
  document.body.replaceChildren();
  const container = document.createElement("main");
  container.style.cssText = "height:100vh;display:flex";
  document.body.append(container);
  const style = document.createElement("style");
  style.textContent = ".studio-app-frame{width:100%;height:100%;border:0;display:block}";
  document.head.append(style);
  state = { events: [], lint: [], ready: false };
  mounted = mountApp(container, Object.fromEntries(input.source.files.map((file) => [file.path, file.content])), {
    ...input.assets,
    context: input.context,
    title: "Code check",
    hash,
    onHash: (value) => {
      hash = value;
    },
    services: () => ({
      ...(input.artifactId
        ? {
            storage: (request) => sharedStorage(input.scopeId, request, input.conversationId),
            database: (request, signal) => artifactClient.database(input.scopeId, request, input.conversationId, signal),
          }
        : {}),
      ai: (request, signal) => artifactClient.ai(request, { conversationId: input.conversationId }, signal),
      pdf: (request, signal) => artifactClient.pdf(request, { conversationId: input.conversationId }, signal),
      http: async () => {
        throw new CloudError("unavailable", CHECK_UNAVAILABLE);
      },
      capability: async (name, value, signal) => {
        const response = await fetch("/api/assistant/artifacts/runtime/check/capability", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal,
          body: JSON.stringify({ name, input: value, conversationId: input.conversationId, artifactId: input.artifactId }),
        });
        const result: unknown = await response.json();
        if (!response.ok) throw cloudError(result);
        return result;
      },
    }),
    confirmOpen: async () => {
      throw new CloudError("unavailable", CHECK_UNAVAILABLE);
    },
    onEvent: (event) => {
      if (state.events.length < 200) state.events.push(event);
      else if (!state.events.some((event) => event.type === "error" && event.text === "Diagnostic budget exceeded"))
        state.events[state.events.length - 1] = { type: "error", text: "Diagnostic budget exceeded" };
      if (event.type === "ready") state.ready = true;
    },
    onDownload: async (name, blob) => {
      if (downloadCount >= CHECK_LIMITS.downloads || outputBytes + blob.size > CHECK_LIMITS.outputBytes)
        throw new CloudError("limit", "Check download budget exceeded");
      downloadCount++;
      outputBytes += blob.size;
      const download = downloadQueue.then(async () => {
        const buffer = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let i = 0; i < buffer.length; i += 8192) binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
        await window.assistantCheckDownload(name, btoa(binary), blob.type);
      });
      downloadQueue = download.catch(() => {});
      await download;
    },
  });
  state.lint = mounted.lint;
};
window.assistantCheckInspect = (input) => mounted!.check(input);
window.assistantCheckState = () => state;
window.assistantCheckStop = () => mounted?.stop();
