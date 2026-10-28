import { spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { User } from "@k2b/cloud/contracts";
import type { RuntimeContext } from "@k2b/cloud/ssr";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { Dynamic } from "solid-js/web";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import type { ChatWorkspaceProps } from "./ChatWorkspace.island";

/** Invented shell account, matching the Chat fixture viewer without importing Cloud's own test harness. */
const person = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "reader",
  roles: ["user", "local", "local/user"],
  provider: "local",
  profile: "user",
  givenname: "Robin",
  sn: "Example",
  displayName: "Robin Example",
  mail: "robin@example.test",
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
} satisfies User;

/** Real SSR Cloud Layout around the existing Chat REST/live fixture; no copied shell markup or CSS. */
export const chatShellPage = async (snapshot: (request: Request) => ChatWorkspaceProps) => {
  const root = mkdtempSync(resolve(tmpdir(), "chat-shell-browser-"));
  const { plugin } = createConfig({ dev: true, rootDir: root });
  Bun.plugin(plugin());
  const { defineApp } = await import("@k2b/cloud");
  const settings = await import("@k2b/cloud/server/middleware/settings");
  const help = await import("@k2b/cloud/ssr/help");
  const { Layout } = await import("@k2b/cloud/ssr");
  const { default: ChatWorkspace } = await import("./ChatWorkspace.island");
  const spies = [
    stubRailSnapshot(),
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
