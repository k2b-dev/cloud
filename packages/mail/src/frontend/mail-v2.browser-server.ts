import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { appAccentStyle } from "@k2b/cloud/ssr/app-appearance";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

/**
 * Serves Mail's mailbox on the v2 pilot with the mockup's data (mail-v2.browser-fixture.tsx): server render, the real
 * island bundle, and the few Mail APIs the open page calls. The frame is the one the v2 mockup and the Fibel screen
 * tests measure in: a 56 px rail and an 8 px card inset from 768 px, the phone bar of 52 px below.
 */
const cache = resolve(import.meta.dir, "../../node_modules/.cache");
mkdirSync(cache, { recursive: true });
const root = mkdtempSync(join(cache, "mail-v2-browser-"));
registerSsrTestPlugin({ dev: false, verbose: false, rootDir: root, componentRoots: [import.meta.dir] });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: Fixture, mailV2Data, MAIL_V2_SIGNATURE } = await import("./mail-v2.browser-fixture");
const ui = resolve(import.meta.dir, "../../../ui/dist");
const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", resolve(import.meta.dir, "../../../cloud")))).default;

export const MAIL_V2_PATH = "/app/mail/Box001";

const frame = `html,body{margin:0;height:100%}
.v2-shell{position:fixed;inset:8px 8px 8px 56px;display:flex}
.v2-shell>main{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column}
@media (max-width:767px){.v2-shell{inset:52px 0 0 0}}
solid-island,solid-client{display:contents}`;

export type MailV2Server = {
  url: string;
  /** A new, newest mail arrives: open pages hear it over the live socket and load it on top of the list. */
  arrive: () => void;
  stop: () => Promise<void>;
};

/** `now` freezes the demo's clock (the tests); without it the demo's mails are as old as the mockup says, from now. */
export const startMailV2Server = async (options: { port?: number; hostname?: string; now?: () => number } = {}): Promise<MailV2Server> => {
  const builds = await Promise.all(
    [resolve(import.meta.dir, "../../../../styles.css"), resolve(import.meta.dir, "../styles/app.css")].map((entry) =>
      Bun.build({ entrypoints: [entry], plugins: [tailwind] }),
    ),
  );
  for (const build of builds) if (!build.success) throw new AggregateError(build.logs, "Mail v2 CSS failed");
  const css = (await Promise.all(builds.flatMap((build) => build.outputs.map((output) => output.text())))).join("\n");
  // Cloud's shell runtime owns history as on a real page (ShellRuntime): back and forward restore each list's place.
  const shellEntry = join(root, "shell.ts");
  const shellBuild = await Bun.build({
    entrypoints: [shellEntry],
    files: { [shellEntry]: 'import { installPageSwap } from "@k2b/ssr/nav"; installPageSwap();' },
    target: "browser",
    format: "iife",
    conditions: ["browser"],
  });
  if (!shellBuild.success) throw new AggregateError(shellBuild.logs, "Mail v2 shell failed");
  const shell = await shellBuild.outputs[0]!.text();
  const now = options.now ?? Date.now;
  const subscriptions = new Set<{ socket: { send(data: string): unknown }; id: string }>();
  let arrived = 0;
  const data = (target: URL) => {
    const shown = mailV2Data(target, now());
    const first = shown.listItems[0];
    if (!first || arrived === 0) return shown;
    const fresh = Array.from({ length: arrived }, (_, index) => ({
      ...first,
      id: `DemoNew${index + 1}`,
      conversationId: `DemoNew${index + 1}`,
      participantLabels: ["Spedition Falk"],
      participantSummary: "Spedition Falk",
      subject: `Neue Sendung ${index + 1}`,
      unread: true,
      localTags: [],
      latestMessageAt: new Date(now() - 60_000 + index * 1000).toISOString(),
    }));
    return { ...shown, listItems: [...fresh.reverse(), ...shown.listItems] };
  };

  const page = (url: URL) => {
    const locale = url.searchParams.get("locale") === "en" ? "en" : "de";
    const html = renderToString(() => createComponent(Fixture, { source: `${url.pathname}${url.search}`, locale, now: now() }));
    // The shell runs once the body is parsed (it appends to it), and before the islands, as the module below waits.
    return `<!doctype html><html lang="${locale}" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mail v2</title><link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><link rel="stylesheet" href="/mail-v2.css"><style>${frame}</style><script defer src="/mail-v2-shell.js"></script></head><body class="k2b-ui app-accent-scope" data-theme="light" style="${appAccentStyle("#0f766e")}"><div class="v2-shell"><main class="k2-ui">${html}</main></div><script type="module">
await document.fonts.ready;
await Promise.all(Array.from(document.querySelectorAll('solid-island'),e=>import('/_ssr/'+e.dataset.id+'.js')));
await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
document.documentElement.dataset.mailV2Ready='true';
</script></body></html>`;
  };

  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request, host) {
      const url = new URL(request.url);
      if (url.pathname === "/api/mail/live" && host.upgrade(request, { data: undefined })) return;
      if (url.pathname === "/mail-v2.css") return new Response(css, { headers: { "content-type": "text/css" } });
      if (url.pathname === "/mail-v2-shell.js") return new Response(shell, { headers: { "content-type": "text/javascript" } });
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)));
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))));
      // Cloud's shared typeface as Core serves it; the message frame (a sandboxed document) loads it across origins.
      if (url.pathname === "/public/fonts.css") return new Response(Bun.file(join(ui, "plex.css")));
      if (url.pathname.startsWith("/public/fonts/") && !url.pathname.includes(".."))
        return new Response(Bun.file(join(ui, "fonts", url.pathname.slice("/public/fonts/".length))), {
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      if (url.pathname.endsWith("/workspace-route") || url.pathname.endsWith("/workspace-list")) {
        const target = new URL(url.searchParams.get("href") ?? MAIL_V2_PATH, server.url);
        return Response.json(data(target));
      }
      // The open conversation's part of the page, as Mail's detail route answers it.
      const detail = /\/workspace-detail\/([^/]+)$/.exec(url.pathname);
      if (detail) {
        const target = new URL(MAIL_V2_PATH, server.url);
        target.searchParams.set("conversation", detail[1]!);
        const page = data(target);
        return Response.json({
          conversationId: detail[1],
          localTags: page.localTags,
          selectedSubject: page.selectedSubject,
          detailMessages: page.detailMessages,
          conversationRowState: page.conversationRowState,
          conversationSummary: page.conversationSummary,
          conversationDrafts: page.conversationDrafts,
          detailError: page.detailError,
          collaborationState: page.collaborationState,
          conversationLocalTags: page.conversationLocalTags,
          comments: page.comments,
          commentsCursor: page.commentsCursor,
          assignableUsers: page.assignableUsers,
          activity: page.activity,
          reminder: page.reminder,
          keep: page.keep,
          collaborationError: page.collaborationError,
          detailErrors: page.detailErrors,
          selectedReference: page.selectedReference,
        });
      }
      if (url.pathname.endsWith("/presence")) return Response.json({ participants: [] });
      // What other apps linked to the conversation: the mockup's offer has one task ("1 verknüpft").
      const context = /\/conversations\/([^/]+)\/context$/.exec(url.pathname);
      if (context)
        return Response.json({
          conversationId: context[1],
          participants: [],
          contacts: { status: "absent", items: [], matchedEmails: [], nextCursor: null },
          spaces: {
            status: "ready",
            truncated: false,
            items:
              context[1] === "Demo01"
                ? [
                    {
                      ref: { app: "spaces", type: "task", id: "DemoTask1" },
                      title: "Angebot 4471 prüfen",
                      icon: "ti ti-checkbox",
                      links: [{ rel: "open", href: "/app/spaces/tasks/DemoTask1" }],
                    },
                  ]
                : [],
          },
        });
      // The reply box writes into a seed the server derives, as the v1 suite's fixture answers it; nothing is stored.
      if (url.pathname.endsWith("/compose-signature-defaults")) return Response.json([]);
      if (url.pathname.endsWith("/compose-templates"))
        return Response.json([
          { id: MAIL_V2_SIGNATURE.id, kind: "signature", scope: "mailbox", name: MAIL_V2_SIGNATURE.name, body: MAIL_V2_SIGNATURE.text },
        ]);
      if (url.pathname.endsWith("/compose-signature") && request.method === "POST")
        return Response.json({ html: null, text: MAIL_V2_SIGNATURE.text, mailHtml: null });
      if (url.pathname.endsWith("/draft-seeds") && request.method === "POST") {
        const body: { origin: { input: Record<string, unknown> } } = await request.json();
        const input = body.origin.input;
        return Response.json({
          id: "00000000-0000-4000-8000-0000000000d1",
          mailboxId: "Box001",
          conversationId: input.conversationId,
          intent: input.intent,
          sourceMessageId: input.sourceMessageId,
          derivedFromMessageId: null,
          derivationKind: null,
          content: {
            senderIdentityId: input.senderIdentityId,
            signatureTemplateId: MAIL_V2_SIGNATURE.id,
            quoteSource: input.quoteSource ?? null,
            to: [{ name: "Holzwerk Brandt", address: "einkauf@holzwerk-brandt.example" }],
            cc: [],
            bcc: [],
            subject: input.subject,
            body: input.body ?? "",
            format: "markdown",
            priority: "normal",
            requestDeliveryReceipt: false,
            requestReadReceipt: false,
          },
          attachments: [],
          origin: body.origin,
          createdAt: new Date(now()).toISOString(),
        });
      }
      if (url.pathname.endsWith("/actions") && request.method === "POST") return Response.json({ commands: [] });
      if (url.pathname.endsWith("/conversations/completion") && request.method === "POST") {
        const input: { conversationIds: string[]; completion: "done" | "open" } = await request.json();
        return Response.json({
          completion: input.completion,
          results: input.conversationIds.map((conversationId) => ({
            conversationId,
            status: "ok",
            workStatus: input.completion === "done" ? "done" : "needs_action",
            revision: 2,
          })),
        });
      }
      if (url.pathname.endsWith("/preference") && request.method === "PATCH") return Response.json(await request.json());
      if (url.pathname.endsWith("/activity")) return Response.json({ items: [], nextCursor: null });
      if (url.pathname.startsWith("/api/")) return Response.json({ error: "Outside the v2 fixture" }, { status: 404 });
      if (url.pathname.startsWith("/app/mail/Box"))
        return new Response(page(url), { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const frame: { t?: string; id?: string } = JSON.parse(String(message));
        if (frame.t !== "sub" || !frame.id) return;
        subscriptions.add({ socket, id: frame.id });
        socket.send(JSON.stringify({ t: "ready", id: frame.id, cursor: "s6t.mail.4" }));
      },
      close(socket) {
        for (const subscription of subscriptions) if (subscription.socket === socket) subscriptions.delete(subscription);
      },
    },
  });
  return {
    url: server.url.href.replace(/\/$/, ""),
    arrive: () => {
      arrived += 1;
      for (const { socket, id } of subscriptions)
        socket.send(JSON.stringify({ t: "event", id, cursor: `s6t.mail.${4 + arrived}`, data: { conversationId: null } }));
    },
    stop: () => server.stop(true),
  };
};
