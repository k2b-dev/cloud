import { spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import type { User } from "@k2b/cloud/contracts";
import type { RuntimeContext } from "@k2b/cloud/ssr";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { buildIslandClosure } from "../../../../scripts/fixtures/island-closure";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { assistantPanelFixture } from "../../../assistant/src/frontend/AssistantPanel.test-fixture";
import { startChatHarness, viewer } from "./ChatWorkspace.browser-fixture";

/** Public Layout/PanelLayout with the actual Chat workspace and its existing synthetic REST/live fixture. */
export async function startConversationPanelFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "conversation-panel-"));
  const { plugin } = createConfig({ dev: true, rootDir: root });
  Bun.plugin(plugin());
  const [{ defineApp }, { Layout, PanelLayout }, { default: ChatWorkspace }, { default: AssistantWorkspace }, settings, help, consent] =
    await Promise.all([
      import("@k2b/cloud"),
      import("@k2b/cloud/ssr"),
      import("./ChatWorkspace.island"),
      import("../../../assistant/src/frontend/AssistantWorkspace.island"),
      import("@k2b/cloud/server/middleware/settings"),
      import("@k2b/cloud/ssr/help"),
      import("@k2b/cloud/services/panel-context-consent"),
    ]);
  const backend = await startChatHarness();
  const assistant = assistantPanelFixture();
  let contextAllowed = false;
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", resolve(import.meta.dir, "../../../cloud")))).default;
  const cssBuild = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../../assistant/src/styles/app.css")],
    plugins: [tailwind],
  });
  if (!cssBuild.success) {
    backend.stop();
    throw new AggregateError(cssBuild.logs, "Assistant stylesheet build failed");
  }
  const assistantCss = await cssBuild.outputs[0]!.text();
  const spies = [
    stubRailSnapshot(),
    spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
    spyOn(consent.panelContextConsent, "get").mockImplementation(async () => ({ allowed: contextAllowed, revision: 1 })),
  ];
  try {
    const person: User = {
      id: viewer.id,
      uid: "reader",
      roles: ["user", "local", "local/user"],
      provider: "local",
      profile: "user",
      givenname: "Robin",
      sn: "Example",
      displayName: viewer.name,
      mail: "robin@example.test",
      avatarHash: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
      ipa: null,
    };
    const apps = [
      {
        id: "fixture",
        name: "Host application",
        description: "Synthetic host",
        icon: "ti ti-table",
        routes: ["/app/fixture"],
        nav: { href: "/app/fixture", section: "primary" as const },
      },
      {
        id: "chat",
        name: "Chat",
        description: "Chat",
        icon: "ti ti-messages",
        routes: ["/app/chat"],
        nav: { href: "/app/chat", section: "primary" as const },
        panel: { href: "/app/chat/panel", label: "Chat", icon: "ti ti-messages" },
      },
      {
        id: "assistant",
        name: "Assistant",
        description: "Assistant",
        icon: "ti ti-sparkles",
        routes: ["/app/assistant"],
        nav: { href: "/app/assistant", section: "primary" as const },
        panel: { href: "/app/assistant/panel", label: "Assistant", icon: "ti ti-sparkles" },
      },
      {
        id: "second",
        name: "Second provider",
        description: "Synthetic provider",
        icon: "ti ti-help",
        routes: ["/app/second"],
        panel: { href: "/app/second/panel", label: "Second provider", icon: "ti ti-help" },
      },
    ];
    const app = defineApp({ ...apps[0]!, baseUrl: "http://fixture:3000" });
    type Environment = { Variables: { runtime: RuntimeContext; user: User } };
    const routes = new Hono<Environment>()
      .use(async (c, next) => {
        c.set("runtime", { apps });
        c.set("user", person);
        await next();
      })
      .get(
        "*",
        ...app.ssr<Environment>((c) => {
          const url = new URL(c.req.url);
          const embedded = /\/app\/(chat|assistant)\/panel/.test(url.pathname);
          const assistantPage = url.pathname.startsWith("/app/assistant");
          const chatPage = url.pathname.startsWith("/app/chat");
          const id = /\/c\/([^/]+)/.exec(url.pathname)?.[1];
          const snapshot = { ...backend.props({ chat: id }), embedded };
          const content = () =>
            assistantPage ? (
              <>
                <script
                  id="assistant-props"
                  type="application/json"
                  innerHTML={JSON.stringify(assistant.snapshot(url)).replace(/</g, "\\u003c")}
                />
                <div id="assistant-workspace" class="flex min-h-0 flex-1 flex-col">
                  {createComponent(AssistantWorkspace, assistant.snapshot(url))}
                </div>
              </>
            ) : chatPage ? (
              <>
                <script id="chat-props" type="application/json" innerHTML={JSON.stringify(snapshot).replace(/</g, "\\u003c")} />
                <div id="workspace" class="flex min-h-0 flex-1 flex-col">
                  {createComponent(ChatWorkspace, snapshot)}
                </div>
              </>
            ) : (
              <main>
                <h1>Synthetic project</h1>
                <label>
                  Host note <input aria-label="Host note" />
                </label>
                <button id="open-chat" type="button">
                  Open Chat
                </button>
              </main>
            );
          return () =>
            embedded || url.pathname.startsWith("/app/second/panel") ? (
              <PanelLayout c={c} title={chatPage ? "Chat" : "Second provider"}>
                {content()}
              </PanelLayout>
            ) : (
              <Layout c={c} title={chatPage ? "Chat" : "Synthetic project"} fullPage>
                {content()}
              </Layout>
            );
        }),
      );
    const entry = resolve(import.meta.dir, "conversation-panel-client.tsx");
    const panelEntry = resolve(import.meta.dir, "conversation-panel-runtime.tsx");
    const build = await buildIslandClosure([entry, panelEntry], {
      [panelEntry]: `
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import PanelRuntime from "@k2b/cloud/ssr/PanelRuntime.island";
const embedded = document.querySelector("[data-cloud-panel-page]");
const root = document.createElement("div");
document.body.append(root);
render(() => createComponent(PanelRuntime, { provider: embedded.dataset.panelProvider, scope: "/app/" + embedded.dataset.panelProvider + "/panel" }), root);
`,
      [entry]: `
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { LocaleProvider } from "@k2b/ui";
import { openPanel } from "@k2b/cloud/browser/panel";
import ShellRuntime from "@k2b/cloud/ssr/ShellRuntime.island";
import ChatWorkspace from "./ChatWorkspace.island";
import AssistantWorkspace from "../../../assistant/src/frontend/AssistantWorkspace.island";
const embedded = document.querySelector("[data-cloud-panel-page]");
const runtime = document.createElement("div");
document.body.append(runtime);
if (!embedded) render(() => createComponent(LocaleProvider, { locale: "en", get children() {
  return createComponent(ShellRuntime, { panel: true, workspace: { appId: "fixture" }, commands: { searchResources: false } });
}}), runtime);
document.getElementById("open-chat")?.addEventListener("click", () => openPanel("chat"));
const props = document.getElementById("chat-props");
if (props) {
const root = document.getElementById("workspace");
root.replaceChildren();
render(() => createComponent(LocaleProvider, { locale: "en", get children() {
  return createComponent(ChatWorkspace, JSON.parse(props.textContent));
}}), root);
}
const assistantProps = document.getElementById("assistant-props");
if (assistantProps) {
 const root = document.getElementById("assistant-workspace"); root.replaceChildren();
 render(() => createComponent(AssistantWorkspace, JSON.parse(assistantProps.textContent)), root);
}
document.documentElement.dataset.fixtureReady = "true";
`,
    });
    const outputUrl = (path: string) => "/" + relative(process.cwd(), resolve(path));
    const outputs = new Map(await Promise.all(build.outputs.map(async (output) => [outputUrl(output.path), await output.text()] as const)));
    const script = Object.entries(build.metafile!.outputs).find(
      ([, output]) => output.entryPoint && resolve(output.entryPoint) === entry,
    )?.[0];
    const panelScript = Object.entries(build.metafile!.outputs).find(
      ([, output]) => output.entryPoint && resolve(output.entryPoint) === panelEntry,
    )?.[0];
    if (!script || !panelScript) throw new Error("Missing fixture client");
    type SocketData = { upstream: WebSocket | null; pending: string[] };
    const server = Bun.serve<SocketData>({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request, server) {
        const url = new URL(request.url);
        if (url.pathname === "/api/chat/live")
          return server.upgrade(request, { data: { upstream: null, pending: [] } }) ? undefined : new Response(null, { status: 400 });
        if (outputs.has(url.pathname)) return new Response(outputs.get(url.pathname), { headers: { "content-type": "text/javascript" } });
        if (url.pathname.startsWith("/api/me/panel-consent"))
          return Response.json({
            answers: {
              assistant: { allowed: contextAllowed, revision: 1 },
              chat: { allowed: false, revision: 1 },
              second: { allowed: false, revision: 1 },
            },
          });
        if (url.pathname === "/styles.css") {
          const css = await fetch(new URL("styles.css", backend.url));
          return new Response((await css.text()) + "\n" + assistantCss, { headers: { "content-type": "text/css" } });
        }
        const assistantResponse = await assistant.respond(request);
        if (assistantResponse) return assistantResponse;
        if (!url.pathname.startsWith("/app/")) return fetch(new Request(new URL(url.pathname + url.search, backend.url), request));
        const response = await routes.fetch(request);
        const html = await new HTMLRewriter()
          .on('script[src], script[type="module"], link[rel="stylesheet"], link[rel="preload"], link[rel="modulepreload"]', {
            element: (element) => void element.remove(),
          })
          .transform(response)
          .text();
        return new Response(
          html
            .replace("</head>", '<link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/styles.css"></head>')
            .replace(
              "</body>",
              `<script type="module" src="${outputUrl(script)}"></script>${html.includes("data-cloud-panel-page") ? `<script type="module" src="${outputUrl(panelScript)}?provider=${url.pathname.startsWith("/app/assistant") ? "assistant" : "chat"}"></script>` : ""}</body>`,
            ),
          { headers: { "content-type": "text/html" } },
        );
      },
      websocket: {
        open(socket) {
          const upstream = new WebSocket(backend.url.replace("http:", "ws:") + "api/chat/live");
          socket.data.upstream = upstream;
          upstream.onopen = () => {
            for (const message of socket.data.pending.splice(0)) upstream.send(message);
          };
          upstream.onmessage = (event) => socket.send(String(event.data));
          upstream.onclose = () => socket.close();
          upstream.onerror = () => socket.close();
        },
        message(socket, message) {
          if (socket.data.upstream?.readyState === WebSocket.OPEN) socket.data.upstream.send(String(message));
          else socket.data.pending.push(String(message));
        },
        close(socket) {
          socket.data.upstream?.close();
        },
      },
    });
    return {
      backend,
      assistant,
      allowContext: (allowed: boolean) => {
        contextAllowed = allowed;
      },
      url: server.url.href,
      panelRuntimePath: `${outputUrl(panelScript)}?provider=assistant`,
      stop: () => {
        server.stop(true);
        backend.stop();
        for (const spy of spies) spy.mockRestore();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    backend.stop();
    for (const spy of spies) spy.mockRestore();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
