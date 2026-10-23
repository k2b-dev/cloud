import { afterEach, describe, expect, test } from "bun:test";
import { decodeTableActionIntent, decodeTableFocus, encodeTableFocus, TEXT_TABLE_ACTION_MAX_LENGTH } from "@k2b/cloud/browser/shared-text";
import { fromBase64, planTableAction, prepareTableActionFocus } from "@k2b/cloud/shared-text";
import type { MenuAction, TableTarget } from "@k2b/ui/text-editor";
import { findTables, gridLine } from "@k2b/ui/text-editor/model";
import * as Y from "yjs";
import type { z } from "zod";
import { createStructuralFixture } from "../../../../../scripts/fixtures/shared-text-history";
import { draftTableActionRequestSchema } from "../../lib/draft-document-contract";
import {
  createMailDraftTableStructure,
  MAIL_EDITOR_MAX_LENGTH,
  type TableActionResponse,
  type UnknownTableAction,
} from "./mail-draft-document-table";

type MailTableActionRequest = z.infer<typeof draftTableActionRequestSchema>;

const markdown = "Intro\n\n| Item | Cost |\n| --- | ---: |\n| Paper | 4 |\n| Ink | 2 |\n\nAfter";
const reply = (status: number, body: unknown): TableActionResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

const setup = (respond: (request: MailTableActionRequest) => Promise<TableActionResponse>) => {
  const fixture = createStructuralFixture(markdown);
  disposals.push(fixture.destroy);
  const { text, manager: history, history: actions } = fixture.own;
  const events: string[] = [];
  const requests: MailTableActionRequest[] = [];
  const notices: string[] = [];
  const unknown: (UnknownTableAction | null)[] = [];
  let online = true;
  const structure = createMailDraftTableStructure({
    ytext: text,
    provider: {
      setInverseHandler: actions.setInverseHandler,
      canStructure: () => online && !actions.hasPending(),
      generation: () => "7",
      beginAction: (id) => {
        events.push("begin");
        return actions.begin(id);
      },
    },
    post: async (request) => {
      events.push("post");
      requests.push(request);
      return respond(request);
    },
    notify: (message) => notices.push(message),
    fallback: () => "fallback",
    onUnknown: (action) => unknown.push(action),
  });
  const target = (row: number, column: number): TableTarget => {
    const table = findTables(text.toString())[0]!;
    return {
      tableFrom: table.from,
      rowFrom: gridLine(table, row)!.from,
      columnFrom: table.lines[0]!.cells[column]!.from,
      row,
      column,
    };
  };
  /** The server's half: plan against its own replica and deliver the receipt through the live stream. */
  const deliver = async (request: MailTableActionRequest) => {
    const intent = decodeTableActionIntent(request.intent);
    let focus: ReturnType<typeof encodeTableFocus> | null = null;
    let prepared: { state: Uint8Array; finish: ReturnType<typeof prepareTableActionFocus> } | undefined;
    if ("receiptCursor" in intent) {
      await fixture.documents().inverse("fixture", {
        actor: fixture.own.actor,
        restoreRevision: "0",
        maxLength: TEXT_TABLE_ACTION_MAX_LENGTH,
        actionId: request.actionId,
        receiptCursor: intent.receiptCursor,
      });
    } else {
      await fixture
        .documents()
        .change("fixture", { actor: fixture.own.actor, actionId: request.actionId, maxLength: TEXT_TABLE_ACTION_MAX_LENGTH }, (current) => {
          const server = new Y.Doc();
          try {
            Y.applyUpdate(server, current.state());
            const text = server.getText("codemirror");
            const changes = planTableAction(text, intent, TEXT_TABLE_ACTION_MAX_LENGTH);
            const finish = request.focus
              ? prepareTableActionFocus(text, intent, decodeTableFocus(request.focus), request.caret)
              : undefined;
            // Capture actual IDs AFTER the production writer applies receipt.
            if (finish) prepared = { state: current.state(), finish };
            return changes;
          } finally {
            server.destroy();
          }
        });
    }
    if (prepared) {
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, prepared.state);
        Y.applyUpdate(doc, fromBase64(fixture.events.at(-1)!.data.payload));
        const witness = prepared.finish(doc.getText("codemirror"));
        focus = witness ? encodeTableFocus(witness) : null;
      } finally {
        doc.destroy();
      }
    }
    fixture.deliver(fixture.own);
    return focus;
  };
  return {
    text,
    history,
    destroy: fixture.destroy,
    actions,
    structure,
    events,
    requests,
    notices,
    unknown,
    target,
    deliver,
    setOnline: (value: boolean) => {
      online = value;
    },
  };
};

const perform = (setupResult: ReturnType<typeof setup>, action: MenuAction, row = 1, column = 1) =>
  setupResult.structure.perform(action, setupResult.target(row, column));

describe("Mail table structure transport", () => {
  test("captures canonical anchors and registers the receipt before the request", async () => {
    let resolveReply!: (response: TableActionResponse) => void;
    const env = setup(() => new Promise((resolve) => (resolveReply = resolve)));
    const done = perform(env, "colRight");
    // Synchronous part: the pending receipt exists before the request leaves.
    expect(env.events).toEqual(["begin", "post"]);
    expect(env.actions.hasPending()).toBe(true);
    const request = env.requests[0]!;
    expect(draftTableActionRequestSchema.parse(request)).toEqual(request);
    expect(request.generation).toBe("7");
    expect(request.actionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.intent.action).toBe("colRight");
    await env.deliver(request);
    resolveReply(reply(200, { changed: true, cursor: "8", receipt: null }));
    await done;
    expect(env.text.toString()).toContain("| Item | Cost |   |\n| --- | ---: | --- |");
    // Native history has no raw structural inverse. Authorized Undo consumes
    // the receipt frame and waits for its own correlated stream event.
    expect(env.history.undoStack).toHaveLength(0);
    const undone = env.actions.undo();
    const inverse = env.requests.at(-1)!;
    expect(inverse.intent).toMatchObject({ action: "undo", receiptCursor: "s6t.history.1" });
    await env.deliver(inverse);
    resolveReply(reply(200, { changed: true }));
    await undone;
    expect(env.text.toString()).toBe(markdown);
    expect(env.notices).toEqual([]);
  });

  test("an accepted action waits for the stream even when saving failed, and never applies HTTP bytes", async () => {
    const env = setup(async () =>
      reply(200, {
        changed: true,
        persisted: false,
        message: "Saved later",
        code: "table_action_persist_failed",
        accepted: true,
        cursor: "8",
        receipt: null,
      }),
    );
    let settled = false;
    const done = perform(env, "alignCenter").then(() => {
      settled = true;
    });
    await Bun.sleep(0);
    expect(env.notices).toEqual(["Saved later"]);
    expect(settled).toBe(false);
    expect(env.text.toString()).toBe(markdown);
    await env.deliver(env.requests[0]!);
    await done;
    expect(env.text.toString()).toContain(":---:");
  });

  test("a known rejection cancels the pending action and shows the server's message", async () => {
    const env = setup(async () =>
      reply(409, { message: "The table changed.", code: "table_target_rejected", accepted: false, cursor: null, receipt: null }),
    );
    await perform(env, "deleteCol");
    expect(env.notices).toEqual(["The table changed."]);
    expect(env.actions.hasPending()).toBe(false);
    expect(env.structure.available()).toBe(true);
    expect(env.text.toString()).toBe(markdown);
  });

  test("a failure before the action ran is a rejection; a missing message uses the fallback", async () => {
    const env = setup(async () => reply(403, {}));
    await perform(env, "deleteCol");
    expect(env.notices).toEqual(["fallback"]);
    expect(env.actions.hasPending()).toBe(false);
  });

  test("an unchanged action ends quietly", async () => {
    const env = setup(async () => reply(200, { changed: false, accepted: false, persisted: true, cursor: null, receipt: null }));
    await perform(env, "alignLeft");
    expect(env.notices).toEqual([]);
    expect(env.actions.hasPending()).toBe(false);
  });

  for (const [name, respond] of [
    [
      "an unknown publication outcome",
      async () => reply(500, { message: "Unknown", code: "table_action_outcome_unknown", accepted: null }),
    ],
    ["HTTP 200 with unknown publication", async () => reply(200, { changed: false, accepted: null, persisted: false })],
    ["a network failure", async () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a gateway error without a body", async () => reply(502, null)],
  ] as const) {
    test(`${name} keeps the action pending without resubmitting until the person stops waiting`, async () => {
      const env = setup(respond);
      const done = perform(env, "colLeft");
      await Bun.sleep(0);
      expect(env.unknown).toHaveLength(1);
      expect(env.structure.available()).toBe(false);
      expect(env.requests).toHaveLength(1);
      env.unknown[0]!.stopWaiting();
      await done;
      expect(env.unknown.at(-1)).toBeNull();
      expect(env.structure.available()).toBe(true);
      expect(env.requests).toHaveLength(1);
      expect(env.notices).toEqual([]);
    });
  }

  test("an unknown outcome clears itself when the action arrives on the stream", async () => {
    const env = setup(async () => Promise.reject(new TypeError("Failed to fetch")));
    const done = perform(env, "colRight");
    await Bun.sleep(0);
    await env.deliver(env.requests[0]!);
    await done;
    expect(env.unknown).toEqual([expect.objectContaining({ message: null }), null]);
    expect(env.text.toString()).toContain("| Item | Cost |   |\n| --- | ---: | --- |");
  });

  test("never begins or sends an action while replay, unsent edits or the connection block it", () => {
    const env = setup(async () => reply(200, { changed: true }));
    env.setOnline(false);
    expect(env.structure.available()).toBe(false);
    expect(() => perform(env, "colRight")).toThrow();
    expect(env.events).toEqual([]);
  });

  test("a removed target is rejected before anything is sent", () => {
    const env = setup(async () => reply(200, { changed: true }));
    const stale = env.target(1, 1);
    env.text.delete(0, env.text.length);
    env.text.insert(0, "No table");
    expect(() => env.structure.perform("deleteRow", stale)).toThrow();
    expect(env.events).toEqual([]);
    expect(env.actions.hasPending()).toBe(false);
  });

  test("the editor limit matches the server's table action limit", () => {
    expect(MAIL_EDITOR_MAX_LENGTH).toBe(TEXT_TABLE_ACTION_MAX_LENGTH);
  });
});

test("structural Markdown source applies only through a correlated server receipt and has authorized Undo", async () => {
  const env = setup(async () => reply(200, { changed: true }));
  const table = findTables(env.text.toString())[0]!;
  const expected = env.text.toString().slice(table.from, table.to);
  const source = "| New | Other | Third |\n| --- | --- | --- |\n| Paper | 4 | kept |\n| Ink | 2 | more |";
  const done = env.structure.replaceSource(env.target(0, 0), expected, source);
  const request = env.requests.at(-1)!;
  expect(draftTableActionRequestSchema.parse(request)).toEqual(request);
  expect(request.intent).toMatchObject({ action: "replaceSource", expected, source });
  expect(env.text.toString()).toBe(markdown);
  await env.deliver(request);
  await done;
  expect(env.text.toString()).toBe(markdown.replace(expected, source));
  expect(env.history.undoStack).toHaveLength(0);
  const undone = env.actions.undo();
  await env.deliver(env.requests.at(-1)!);
  await undone;
  expect(env.text.toString()).toBe(markdown);
});

test("rejected or cancelled structural source keeps a rejected promise so the UI preserves its editable draft", async () => {
  const rejected = setup(async () => reply(409, { accepted: false, message: "Changed target" }));
  const table = findTables(markdown)[0]!;
  const expected = markdown.slice(table.from, table.to);
  await expect(rejected.structure.replaceSource(rejected.target(0, 0), expected, expected + "\n| a | b |")).rejects.toThrow(
    "Changed target",
  );
  expect(rejected.text.toString()).toBe(markdown);
  const unknown = setup(async () => reply(500, { accepted: null }));
  const done = unknown.structure.replaceSource(unknown.target(0, 0), expected, expected + "\n| a | b |");
  await Bun.sleep(0);
  unknown.unknown.at(-1)!.stopWaiting();
  await expect(done).rejects.toThrow("Stopped waiting");
  expect(unknown.unknown.at(-1)).toBeNull();
  expect(unknown.text.toString()).toBe(markdown);
});

for (const source of [false, true])
  test(`bridge returns current receipt focus only after stream and HTTP, source=${source}`, async () => {
    let respond!: (response: TableActionResponse) => void;
    const env = setup(() => new Promise((resolve) => (respond = resolve)));
    const table = findTables(env.text.toString())[0]!;
    const done = source
      ? env.structure.replaceSource(
          env.target(1, 0),
          markdown.slice(table.from, table.to),
          "| A | B | C |\n| --- | --- | --- |\n| a | b | c |",
          { row: 1, column: 2 },
        )
      : perform(env, "colRight", 1, 0);
    const focus = await env.deliver(env.requests.at(-1)!);
    respond(reply(200, { changed: true, focus }));
    const resolve = await done;
    expect(typeof resolve).toBe("function");
    if (!resolve) throw new Error("Missing focus resolver");
    expect(resolve()).toMatchObject({ row: 1, column: source ? 2 : 1 });
    env.text.insert(0, "prefix\n\n");
    expect(resolve()!.tableFrom).toBe(table.from + 8);
    env.text.delete(0, env.text.length);
    expect(resolve()).toBeNull();
  });
