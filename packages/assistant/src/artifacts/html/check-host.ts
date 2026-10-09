// Browser half of code_check: composes and mounts through the existing host.
import { artifactClient } from "../client";
import type { ArtifactSource } from "../contracts";
import { PdfRequest } from "../pdf-contracts";
import type { RuntimeContext } from "../runtime/cloud";
import { CloudError, cloudError } from "../runtime/errors";
import { sharedStorage } from "../runtime/shared-storage";
import type { AppFrameAssets } from "./assets";
import { CHECK_LIMITS, CHECK_UNAVAILABLE } from "./check-contracts";
import { type LayoutFinding, misalignedRows, shownProblems, shownText } from "./check-layout";
import type { CheckCommand } from "./check-realm";
import { type Mount, type MountEvent, mountApp } from "./host";

export type CheckState = { events: MountEvent[]; lint: Mount["lint"]; ready: boolean; pdf: LayoutFinding[] };
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

/** Page sizes in millimetres, as the PDF renderer uses them; 15 mm is its default margin. */
const PAGES = { A4: [210, 297], A3: [297, 420], A5: [148, 210], Letter: [215.9, 279.4], Legal: [215.9, 355.6] } as const;
const PDF_FINDINGS = 10;
/** The renderer prints: print rules apply and screen rules do not, such as the base stylesheet's print body. */
function printMedia(media: MediaList) {
  if (!media.length) return;
  media.mediaText = [...media]
    .map((query) => {
      const q = query.trim().replace(/^only\s+/i, "");
      if (/^not\s+screen\b/i.test(q)) return "all";
      if (/^screen\b/i.test(q)) return "not all";
      return q.replace(/^(not\s+)?print\b/i, "$1all");
    })
    .join(", ");
}
function printRules(rules: CSSRuleList, view: Window & typeof globalThis) {
  for (const rule of rules) {
    if (rule instanceof view.CSSMediaRule) printMedia(rule.media);
    if (rule instanceof view.CSSGroupingRule) printRules(rule.cssRules, view);
  }
}
/**
 * Lays out the HTML of a PDF at its printed width, the way the renderer receives it (base stylesheet first, print
 * media), and measures it like the app before it is printed. The frame runs no script and loads nothing: images
 * from `assets` are missing, which the findings, resting on margins and text, do not depend on. Studio apps keep
 * their CSS in `<style>`, as `<link>` fails their lint.
 */
async function inspectPdf(input: unknown, baseCss: string): Promise<LayoutFinding[]> {
  const parsed = PdfRequest.safeParse(input);
  if (!parsed.success || parsed.data.operation === "attach") return [];
  const { html, page } = parsed.data;
  const [short, long] = PAGES[page.format];
  const margin = { left: 15, right: 15, ...page.margin };
  const width = ((page.landscape ? long : short) - margin.left - margin.right) * (96 / 25.4);
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${Math.max(1, Math.round(width))}px;height:1000px;border:0`;
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
  frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${baseCss}</style>${html}`;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("PDF layout timed out")), 5000);
      frame.addEventListener("load", () => (clearTimeout(timer), resolve()), { once: true });
      document.body.append(frame);
    });
    const doc = frame.contentDocument,
      view = doc?.defaultView;
    if (!doc?.body || !view) return [];
    for (const sheet of doc.styleSheets)
      try {
        printMedia(sheet.media);
        printRules(sheet.cssRules, view);
      } catch {
        // A stylesheet the frame blocked has no readable rules.
      }
    await Promise.race([doc.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2000))]);
    return [...misalignedRows(doc.body), ...shownProblems(shownText(doc.body), "The PDF")].map((finding) => ({
      ...finding,
      kind: `pdf-${finding.kind}`,
      key: `pdf ${finding.key}`,
      message: finding.message.startsWith("The PDF") ? finding.message : `In the PDF: ${finding.message}`,
    }));
  } finally {
    frame.remove();
  }
}
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
  state = { events: [], lint: [], ready: false, pdf: [] };
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
      pdf: async (request, signal) => {
        // A measurement problem never fails the app's PDF; the renderer still decides.
        const findings = await inspectPdf(request, input.assets.baseCss).catch(() => []);
        const pending = state.pdf;
        for (const finding of findings)
          if (pending.length < PDF_FINDINGS && !pending.some((known) => known.key === finding.key)) pending.push(finding);
        return artifactClient.pdf(request, { conversationId: input.conversationId }, signal);
      },
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
