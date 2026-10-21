import { spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { User } from "../../../cloud/src/contracts/shared";
import type { RuntimeContext } from "../../../cloud/src/ssr/runtime";
import type { ChatWorkspaceProps } from "./ChatWorkspace.island";

/** Real SSR Cloud Layout around the existing Chat REST/live fixture; no copied shell markup or CSS. */
export const chatShellPage = async (snapshot: (request: Request) => ChatWorkspaceProps) => {
  const root = mkdtempSync(resolve(tmpdir(), "chat-shell-browser-"));
  const { plugin } = createConfig({ dev: true, rootDir: root });
  Bun.plugin(plugin());
  const { defineApp } = await import("../../../cloud/src/_internal/define-app");
  const { person } = await import("../../../cloud/src/_internal/define-app.test-fixture");
  const rail = await import("../../../cloud/src/services/rail-snapshot");
  const settings = await import("../../../cloud/src/server/middleware/settings");
  const help = await import("../../../cloud/src/ssr/help");
  const { defaultRailPreferences } = await import("../../../cloud/src/contracts/rail-preferences");
  const { default: Layout } = await import("../../../cloud/src/ssr/Layout");
  const { default: ChatWorkspace } = await import("./ChatWorkspace.island");
  const spies = [
    spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
    spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
  ];
  const chat = {
    id: "chat",
    name: "Chat",
    icon: "ti ti-messages",
    description: "Chat browser fixture",
    routes: ["/app/chat"],
    nav: { href: "/app/chat", section: "primary" as const },
  };
  const app = defineApp({ ...chat, baseUrl: "http://chat:3000" });
  // The nightly smoke registers these three apps. Let the real shell project
  // the same phone navigation rather than supplying test-owned bar markup.
  const apps = [
    chat,
    {
      id: "grids",
      name: "Grids",
      icon: "ti ti-table",
      description: "Tables",
      routes: ["/app/grids"],
      nav: { href: "/app/grids?recent=true", match: "/app/grids", section: "primary" as const },
    },
    {
      id: "mail",
      name: "Mail",
      icon: "ti ti-mail",
      description: "Mail",
      routes: ["/app/mail"],
      nav: { href: "/app/mail", section: "primary" as const },
    },
  ];
  type Environment = { Variables: { runtime: RuntimeContext; user: User } };
  const server = new Hono<Environment>()
    .use(async (c, next) => {
      c.set("runtime", { apps });
      c.set("user", person);
      await next();
    })
    .get(
      "*",
      ...app.ssr<Environment>((c) => {
        const props = snapshot(c.req.raw);
        return () =>
          createComponent(Layout, {
            c,
            fullPage: true,
            title: [
              { title: "Start", href: "/" },
              props.chatId ? { title: "Chat", href: "/app/chat" } : { title: "Chat" },
              ...(props.chatId ? [{ title: props.open?.conversation.title ?? "No access" }] : []),
            ],
            get children() {
              return createComponent(Dynamic, {
                component: "solid-island",
                id: "root",
                get children() {
                  return createComponent(ChatWorkspace, props);
                },
              });
            },
          });
      }),
    );
  return {
    render: async (request: Request) => {
      const response = await server.request(request);
      // Mount the real Chat island explicitly, as the existing workspace suite does.
      // Keep all server shell markup; the fixture serves its own compiled styles and fonts.
      const html = await new HTMLRewriter()
        .on('script[src], script[type="module"], link[rel="stylesheet"], link[rel="preload"], link[rel="modulepreload"]', {
          element: (element) => void element.remove(),
        })
        .transform(response)
        .text();
      return new Response(
        html
          .replace("</head>", '<link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/styles.css"></head>')
          .replace("</body>", '<script src="/harness.js"></script></body>'),
        { headers: { "Content-Type": "text/html" } },
      );
    },
    stop: () => {
      for (const spy of spies) spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    },
  };
};
