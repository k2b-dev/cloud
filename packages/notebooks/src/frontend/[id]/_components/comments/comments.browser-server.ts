/**
 * A page with the real note editor, its server preview and margin, against an in-memory comments API with fictional
 * people and text. The browser tests start it; `bun comments.browser-server.ts` serves it for screenshots.
 *
 * Query: `s` picks a scenario (see SCENARIOS), `readonly` opens the read-only view, `reader` removes write access,
 * `panel` opens the detail panel, `fullWidth`, `mode=source`, `dark`.
 */
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import { toJSON } from "seroval";
import type { ComponentProps } from "solid-js";
import { createComponent, renderToString } from "solid-js/web";
import * as Y from "yjs";
import type { Annotation, AnnotationProjection } from "../../../../lib/annotation-contracts";
import { notebooksYjs } from "../../../../lib/yjs";
import type NoteEditor from "../editor/NoteEditor.client";
import "../detail/ssr-test-plugin";

const { default: NotePreview } = await import("../editor/NotePreview");

export const NOTE = [
  "# Satzung 2027 – Entwurf",
  "",
  "## § 1 Name und Sitz",
  "",
  "Der Verein führt den Namen „Ruderverein Seewind e.V.“ und hat seinen Sitz in Uferstadt. Er ist im Vereinsregister des Amtsgerichts Uferstadt eingetragen.",
  "",
  "## § 2 Zweck des Vereins",
  "",
  "Zweck des Vereins ist die Förderung des Rudersports für alle Altersgruppen. Der Verein verwirklicht seinen Zweck insbesondere durch regelmäßiges Training, die Teilnahme an Regatten und die Pflege des Bootshauses.",
  "",
  "Der Verein ist selbstlos tätig. Mittel des Vereins dürfen nur für die satzungsmäßigen Zwecke verwendet werden.",
  "",
  "## § 3 Mitgliedschaft",
  "",
  "Mitglied kann jede natürliche Person werden, die das zehnte Lebensjahr vollendet hat. Über den schriftlichen Aufnahmeantrag entscheidet der Vorstand innerhalb von vier Wochen.",
  "",
  "Die Mitgliedschaft endet durch Austritt, Ausschluss oder Tod. Der Austritt ist zum Ende eines Quartals mit einer Frist von sechs Wochen möglich.",
  "",
  "## § 4 Beiträge",
  "",
  "Die Höhe der Beiträge beschließt die Mitgliederversammlung. Der Jahresbeitrag ist bis zum 31. März fällig. Jugendliche zahlen den halben Beitrag.",
  "",
  "## § 5 Vorstand",
  "",
  "Der Vorstand besteht aus der oder dem Vorsitzenden, der Kassenwartin oder dem Kassenwart und der Jugendwartin oder dem Jugendwart. Je zwei Vorstandsmitglieder vertreten den Verein gemeinsam.",
  "",
  "Der Vorstand wird für zwei Jahre gewählt. Er bleibt bis zur Neuwahl im Amt.",
].join("\n");

const people = {
  mk: { kind: "user" as const, id: "00000000-0000-4000-8000-0000000000a1", name: "Mara Keller", avatarHash: null },
  cl: { kind: "user" as const, id: "00000000-0000-4000-8000-0000000000a2", name: "Cem Lorenz", avatarHash: null },
  jb: { kind: "user" as const, id: "00000000-0000-4000-8000-0000000000a3", name: "Jana Berger", avatarHash: null },
  pw: { kind: "user" as const, id: "00000000-0000-4000-8000-0000000000a4", name: "Paul Wagner", avatarHash: null },
  ir: { kind: "user" as const, id: "00000000-0000-4000-8000-0000000000a5", name: "Ida Roth", avatarHash: null },
};
export const ME = people.mk;
/** Every scenario's clock; pages install it (`page.clock`), so relative times read the same in every run. */
export const NOW = Date.parse("2026-10-26T15:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

let serial = 0;
const make = (
  by: keyof typeof people,
  quote: string,
  body: string,
  minutes: number,
  extra: Partial<Annotation> = {},
  text = NOTE,
): Annotation => {
  const from = text.indexOf(quote);
  if (from < 0) throw new Error(`Quote not in note: ${quote}`);
  serial++;
  return {
    id: `00000000-0000-4000-9000-${String(serial).padStart(12, "0")}`,
    noteId: "note01",
    from,
    to: from + quote.length,
    orphan: false,
    startRel: "",
    endRel: "",
    restoreRevision: "0",
    quote,
    prefix: text.slice(Math.max(0, from - 32), from),
    suffix: text.slice(from + quote.length, from + quote.length + 32),
    body,
    suggestion: null,
    state: "open",
    stateBy: null,
    stateAt: null,
    author: people[by],
    via: null,
    createdAt: ago(minutes),
    editedAt: null,
    canEdit: by === "mk" && minutes < 10,
    canDelete: by === "mk" && minutes < 10,
    replies: [],
    repliesNextCursor: null,
    headingPath: [],
    acceptedOperationId: null,
    ...extra,
  };
};

const base = (text = NOTE) => {
  serial = 0;
  const comment = (...args: Parameters<typeof make>) => make(args[0], args[1], args[2], args[3], args[4], text);
  return [
    comment("cl", "das zehnte Lebensjahr vollendet hat", "Im Kinderkurs rudern schon Achtjährige mit. Sollen wir das Alter senken?", 180, {
      suggestion: "das achte Lebensjahr vollendet hat",
      replies: [
        {
          id: "00000000-0000-4000-9100-000000000001",
          author: people.mk,
          via: null,
          body: "Ja, mit Zustimmung der Eltern. Den Satz dazu ergänze ich.",
          createdAt: ago(60),
          editedAt: null,
          canEdit: false,
          canDelete: false,
        },
      ],
    }),
    comment("jb", "innerhalb von vier Wochen", "Schaffen wir das in den Sommerferien? Lieber sechs Wochen.", 120, {
      suggestion: "innerhalb von sechs Wochen",
    }),
    comment(
      "mk",
      "zum Ende eines Quartals mit einer Frist von sechs Wochen",
      "Die Mustersatzung des Landesverbands nennt drei Monate. Ich prüfe das bis Freitag.",
      6,
    ),
    comment("pw", "Jugendliche zahlen den halben Beitrag.", "Bis zu welchem Alter gilt „Jugendliche“? Ich schlage 18 Jahre vor.", 1440, {
      via: "assistant",
      suggestion: "Mitglieder unter 18 Jahren zahlen den halben Beitrag.",
    }),
    comment("cl", "Der Austritt ist zum Ende eines Quartals", "Quartal ist für die Kasse einfacher als Monatsende. Bitte so lassen.", 40),
  ];
};
const comment = make;
const many = () => [
  ...base(),
  comment("ir", "Sitz in Uferstadt", "Der Sitz ist seit dem Umzug Uferstadt-Nord. Bitte prüfen.", 60),
  comment("pw", "für alle Altersgruppen", "„alle Altersgruppen“ ist gut, aber Inklusion fehlt.", 60, {
    suggestion: "für alle Altersgruppen und Menschen mit und ohne Behinderung",
  }),
  comment("jb", "regelmäßiges Training", "Auch Wanderfahrten nennen?", 50),
  comment("ir", "Teilnahme an Regatten", "Regatten nur, wenn genug Boote da sind.", 45),
  comment("cl", "aus der oder dem Vorsitzenden", "Brauchen wir eine Stellvertretung?", 30),
  comment("jb", "Je zwei Vorstandsmitglieder", "Laut Bank muss es „je zwei gemeinsam“ heißen. Passt.", 20),
  comment("pw", "für zwei Jahre gewählt", "Wahl versetzt? Dann ist nie der ganze Vorstand neu.", 10),
  comment("ir", "der Jugendwartin oder dem Jugendwart", "Die Jugend wählt ihre Vertretung selbst, siehe Jugendordnung.", 5),
];
const resolvedSet = () => {
  const items = base();
  items[1] = { ...items[1]!, state: "resolved", stateBy: people.jb, stateAt: ago(30) };
  items[3] = { ...items[3]!, state: "accepted", stateBy: people.mk, stateAt: ago(20) };
  return items;
};
const ORPHAN_QUOTE = " und die Pflege des Bootshauses";
const orphanText = NOTE.replace(ORPHAN_QUOTE, "");
const orphanSet = () => {
  const items = base(orphanText);
  const at = orphanText.indexOf("Regatten.") + "Regatten".length;
  serial++;
  items.push({
    ...comment("ir", "Teilnahme an Regatten", "Die Bootshauspflege gehört in die Hausordnung, nicht in die Satzung.", 60, {}, orphanText),
    quote: ORPHAN_QUOTE.trim(),
    from: at,
    to: at,
    orphan: true,
  });
  return items;
};

/** The comments and text of each scenario; `error` answers every comment read with a failure. */
export const SCENARIOS: Record<string, { text?: string; items: () => Annotation[]; error?: boolean; delay?: number }> = {
  empty: { items: () => [] },
  base: { items: base },
  many: { items: many },
  resolved: { items: resolvedSet },
  orphan: { text: orphanText, items: orphanSet },
  error: { items: base, error: true },
  loading: { items: base, delay: 60_000 },
};

const snapshot = (text: string) => {
  const doc = new Y.Doc();
  doc.getText("codemirror").insert(0, text);
  const result = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  doc.destroy();
  return result;
};

type Call = { method: string; path: string; body: unknown };

export const startCommentsServer = async () => {
  const ui = `${resolve(import.meta.dir, "../../../../../../ui")}/`;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "comments.browser-harness.ts")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-comments-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the note editor with comments.");
  const bundle = await build.outputs[0]!.text();
  const outputs = await Promise.all(
    [resolve(import.meta.dir, "../../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../../styles.css")].map(
      async (entry) => {
        const result = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
        if (!result.success) throw new AggregateError(result.logs, `Could not compile ${entry}.`);
        return result.outputs[0]!.text();
      },
    ),
  );
  const css = ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");

  /** The live comments of the page served last, which the API reads and changes. */
  let scenario = SCENARIOS.base!;
  let text = NOTE;
  let items: Annotation[] = [];
  const calls: Call[] = [];
  /** Keys whose first save failed on purpose ("fail once"). */
  const failedOnce = new Set<string>();
  const projection = (): AnnotationProjection => ({
    text,
    contentHash: "hash",
    cursor: null,
    restoreRevision: "0",
    items: items.filter((item) => !(item as Annotation & { deleted?: boolean }).deleted),
    nextCursor: null,
  });
  const find = (id: string | undefined) => items.find((item) => item.id === id);
  const fail = (status: number, message: string, details?: Record<string, unknown>) =>
    Response.json({ code: status === 409 ? "CONFLICT" : "ERROR", message, ...(details ? { details } : {}) }, { status });

  const api = async (request: Request, url: URL): Promise<Response> => {
    const parts = url.pathname.split("/annotations")[1]!.split("/").filter(Boolean);
    const body = request.method === "GET" || request.method === "DELETE" ? null : await request.json().catch(() => null);
    calls.push({ method: request.method, path: `/${parts.join("/")}`, body });
    if (scenario.delay) await Bun.sleep(scenario.delay);
    if (scenario.error) return fail(500, "Kommentare konnten nicht geladen werden.");
    const [id, action] = parts;
    const item = find(id);
    const input = (body ?? {}) as Record<string, unknown>;
    if (request.method === "GET" && !id) return Response.json(projection());
    if (request.method === "POST" && !id) {
      if (input.body === "fail" || (input.body === "fail once" && !failedOnce.has(String(input.idempotencyKey)))) {
        failedOnce.add(String(input.idempotencyKey));
        return fail(500, "Nicht gespeichert.");
      }
      const quote = String(input.quote);
      const from =
        typeof input.offsetHint === "number" && text.startsWith(quote, input.offsetHint) ? input.offsetHint : text.indexOf(quote);
      const created: Annotation = {
        ...comment("mk", quote, String(input.body ?? ""), 0, { suggestion: (input.suggestion as string | null | undefined) ?? null }, text),
        from,
        to: from + quote.length,
        canEdit: true,
        canDelete: true,
      };
      items.push(created);
      return Response.json(created);
    }
    if (!item) return fail(404, "Notiz oder Kommentar nicht gefunden");
    if (action === "resolve") {
      Object.assign(
        item,
        input.resolved ? { state: "resolved", stateBy: ME, stateAt: new Date(NOW).toISOString() } : { state: "open", stateBy: null },
      );
      return Response.json({ id: item.id, annotationId: item.id, deleted: false });
    }
    if (action === "accept") {
      if (input.expectedText === undefined && text.slice(item.from, item.to) !== item.quote)
        return fail(409, "Der Text wurde inzwischen geändert", { currentText: text.slice(item.from, item.to) });
      // As the server does: the passage becomes the suggestion for everyone, and later passages move with it.
      const insert = item.suggestion ?? "";
      const delta = insert.length - (item.to - item.from);
      text = text.slice(0, item.from) + insert + text.slice(item.to);
      for (const other of items)
        if (other !== item && other.from >= item.to) Object.assign(other, { from: other.from + delta, to: other.to + delta });
      Object.assign(item, { state: "accepted", stateBy: ME, stateAt: new Date(NOW).toISOString(), to: item.from + insert.length });
      return Response.json({ id: item.id, operationId: input.operationId, status: "applied", state: "accepted" });
    }
    if (action === "undo-accept") {
      Object.assign(item, { state: "open", stateBy: null });
      return Response.json({ id: item.id, operationId: input.operationId, status: "applied", state: "open" });
    }
    if (action === "restore") {
      Object.assign(item, { deleted: false });
      return Response.json({ id: item.id, annotationId: item.id, deleted: false });
    }
    if (action === "replies") {
      item.replies.push({
        id: crypto.randomUUID(),
        author: ME,
        via: null,
        body: String(input.body),
        createdAt: new Date(NOW).toISOString(),
        editedAt: null,
        canEdit: true,
        canDelete: true,
      });
      return Response.json(item.replies.at(-1));
    }
    if (request.method === "PATCH") {
      Object.assign(item, { body: String(input.body), editedAt: new Date(NOW).toISOString() });
      return Response.json({ id: item.id, annotationId: item.id, deleted: false });
    }
    if (request.method === "DELETE") {
      Object.assign(item, { deleted: true });
      return Response.json({ id: item.id, annotationId: item.id, deleted: true });
    }
    return fail(404, "Unbekannt");
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/editor.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
      if (url.pathname.startsWith("/ui/")) {
        const file = Bun.file(resolve(ui, "dist", url.pathname.slice(4)));
        return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
      }
      if (url.pathname === "/api/notebooks/ws" && server.upgrade(request, { data: undefined })) return;
      if (url.pathname.includes("/annotations")) return api(request, url);
      if (url.pathname.endsWith("/block-preview")) return Response.json({ markdown: text, blocks: [], diagnostics: [], headings: [] });
      if (url.pathname !== "/") return new Response("Not found", { status: 404 });
      scenario = SCENARIOS[url.searchParams.get("s") ?? "base"] ?? SCENARIOS.base!;
      text = scenario.text ?? NOTE;
      items = scenario.items();
      calls.length = 0;
      const mode = url.searchParams.get("mode") === "source" ? "source" : "rich";
      const readOnly = url.searchParams.has("readonly");
      const canWrite = !url.searchParams.has("reader");
      const panel = url.searchParams.has("panel");
      const fullWidth = url.searchParams.has("fullWidth");
      const initial = scenario.error || scenario.delay ? null : projection();
      const props = {
        noteId: "note01",
        noteTitle: "Satzung 2027 – Entwurf",
        notebookId: "book01",
        notebookName: "Ruderverein Seewind",
        noteLockedAt: null,
        historyIncomplete: false,
        appUrl: url.origin,
        userId: ME.id,
        displayName: ME.name,
        initialContent: text,
        initialPanelOpen: panel,
        initialRichMode: mode,
        readOnly,
        canWrite,
        initialAnnotations: initial,
        initialHref: "/app/notebooks/book01/notes/note01",
        initialDetail: {
          noteAuthors: { createdBy: null, lastEditedBy: null },
          noteId: "note01",
          noteTitle: "Satzung 2027 – Entwurf",
          contentMd: text,
          createdAt: ago(600),
          updatedAt: ago(4),
          lockedAt: null,
          historyIncomplete: false,
          isLocked: false,
          tocItems: [],
          taskProgress: { done: 0, total: 0 },
          attachments: [],
          backlinks: [],
          namedBlocks: [],
        },
      } satisfies ComponentProps<typeof NoteEditor>;
      const preview = renderToString(() =>
        createComponent(NotePreview, { text, mode, historyIncomplete: false, annotations: initial, me: ME.id }),
      );
      const serialized = Bun.escapeHTML(JSON.stringify(toJSON(props)));
      return new Response(
        `<!doctype html><html lang="de"${url.searchParams.has("dark") ? ' class="dark"' : ""}><head>
        <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style>
        <style>solid-client,solid-island{display:contents}#layout{display:flex;height:100dvh}#navigation{width:264px;flex:none;padding:16px;font:14px sans-serif;color:#555}#main{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column}#panel{width:360px;flex:none;padding:16px;font:14px sans-serif}@media(max-width:700px){#navigation{display:none}}</style>
        </head><body class="k2b-ui" style="margin:0"><div id="layout"><nav id="navigation">Ruderverein Seewind</nav><main id="main">
        <div class="notebook-document-surface flex flex-1 min-w-0 min-h-0 flex-col" data-comments=""${fullWidth ? " data-full-width" : ""}${panel ? " data-detail-open" : ""}><solid-client data-id="note-editor" data-props="${serialized}"></solid-client>${preview}</div>
        </main>${panel ? '<aside id="panel">Details</aside>' : ""}</div><script type="module" src="/editor.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
    websocket: {
      open(socket) {
        const updates = [{ cursor: null, payload: snapshot(text), originPeerId: null }];
        socket.send(
          JSON.stringify({ type: notebooksYjs.wsType.syncPush, payload: { noteId: "note01", historyIncomplete: false, updates } }),
        );
        socket.send(JSON.stringify({ type: notebooksYjs.wsType.replayReady, payload: { noteId: "note01" } }));
      },
      message() {},
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
};

if (import.meta.main) {
  const { url } = await startCommentsServer();
  console.log(`Comments harness on ${url}/?s=base`);
}
