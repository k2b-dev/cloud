/**
 * Gate 1 unit schedule harness: real anchored writer, receipt history and
 * ordered snapshot repair; ONLY the topic/job/store transport is in memory.
 * No NATS, SQL, provider, DOM or final Mail send-ordering proof is implied.
 * Run this file in an isolated process: deterministic clock/writer-ID spies
 * are scoped to a case and restored in finally. Never run cases concurrently.
 */
import { spyOn } from "bun:test";
import {
  ConflictError,
  type Job,
  type JobContext,
  type JobSubmit,
  type Topic,
  type TopicEvent,
  type TopicPublish,
  type Worker,
} from "@k2b/sync";
import type { MenuAction } from "@k2b/ui/text-editor";
import * as T from "@k2b/ui/text-editor/model";
import { inspectTableStructure, repairTables } from "@k2b/ui/text-editor/model";
import * as Y from "yjs";
import { renderComposeContent } from "../../mail/src/service/compose-renderer";
import { createSharedTextActionHistory } from "../src/browser/shared-text-history";
import { sanitizeEmailHtml } from "../src/shared/email-html";
import { renderMarkdownSync } from "../src/shared/markdown";
import {
  applySharedTextEvent,
  captureTableAction,
  fromBase64,
  planTableAction,
  SHARED_TEXT_NAME,
  type SharedTextSaveInput,
  type SharedTextSnapshotRequest,
  type SharedTextSnapshotStore,
  type SharedTextStoredState,
  type SharedTextSyncEvent,
  sharedText,
  type TableActionIntent,
  TableActionRejectedError,
  toBase64,
} from "../src/shared-text";
import { bindDocuments, createDoc } from "../src/shared-text/documents";

export type Profile = "realistic" | "adversarial" | "append-undo" | "anchors";
const LIMIT = 2_097_152; // Existing document UTF-16 contract, not a harness cap.
const NOW = 1_792_411_200_000;
const REVISION = "gate1-lineage";
const DOC = "gate1-document";
const cursor = (seq: number) => `s6t.gate1.${seq}`;
const sequence = (value: string | null) => {
  if (value === null) return 0;
  if (!/^s6t\.gate1\.\d+$/.test(value)) throw new Error("Foreign cursor");
  return Number(value.split(".")[2]);
};
const marks = (text: string) => [...text].filter((ch) => ch >= "\ue000" && ch <= "\uf8ff");
const baseMarks = Array.from({ length: 9 }, (_, i) => String.fromCharCode(0xe000 + i));
const composeContext = {
  actor: { display_name: "Ada", email: "ada@example.test" },
  mailbox: { name: "Fixture", description: "" },
  sender: { display_name: "Ada", email: "ada@example.test", reply_to: "" },
  message: { subject: "Table", to: ["reader@example.test"], cc: [] },
};
export const INITIAL = `Before\n\n${T.tableFromGrid([baseMarks.slice(0, 3), baseMarks.slice(3, 6), baseMarks.slice(6)])}\n\nAfter`;

function randomFor(seed: number) {
  return () => {
    seed += 0x6d2b79f5;
    let n = seed;
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 0x100000000;
  };
}

/** Includes extras; a header-width slice would conceal the seed208 defect. */
export function inspectTable(source: string) {
  const tables = T.findTables(source);
  const cells = tables.flatMap((table) => table.lines.filter((_, row) => row !== 1).flatMap((line) => line.cells));
  const outside = marks(source).filter((ch) => {
    const at = source.indexOf(ch);
    return !cells.some((cell) => at >= cell.from && at < cell.to);
  });
  // When Lezer no longer recognizes a table, the shared editor leaves its
  // source visible in CodeMirror. Do not misreport those raw marker characters
  // as hidden merely because they are no longer inside grid cells.
  const visible = cells.map((cell) => T.displayCell(cell.text)).join("\n") + outside.join("");
  const extras = tables.reduce(
    (sum, table) => sum + table.lines.reduce((n, line) => n + Math.max(0, line.cells.length - table.columns), 0),
    0,
  );
  // Omitted outer pipes and short body rows are valid GFM. Extra cells are
  // different: the editor shows them but the email renderer drops them.
  const broken = tables.length !== 1 || outside.length > 0 || extras > 0;
  // Canonical email-profile Markdown plus the actual outgoing HTML sanitizer.
  // This is deliberately not labelled the final Mail compose/send pipeline.
  const html = sanitizeEmailHtml(renderMarkdownSync(source, { output: "email", links: "plain", locale: "en" }));
  const emailVisible = html.replace(/<[^>]*>/g, "");
  const count = (text: string, ch: string) => [...text].filter((value) => value === ch).length;
  const emailMissing = marks(visible).filter((ch) => count(emailVisible, ch) !== count(visible, ch));
  return { broken, extras, visible, outside, emailMissing, html };
}

type Intent = { added: string[]; removed: string[] };
type Frame = Intent & { label: string };
type Token = { created: boolean; deletions: number; owner: number };
type Effects = { created: { token: string; value: boolean }[]; deleted: { token: string; delta: number }[] };
const effectsOf = (intent: Intent, created = true, delta = 1): Effects => ({
  created: intent.added.map((token) => ({ token, value: created })),
  deleted: intent.removed.map((token) => ({ token, delta })),
});
type Packet = { to: number; entry: TopicEvent<SharedTextSyncEvent> };
const emptyIntent = (): Intent => ({ added: [], removed: [] });
const counters = () => ({
  localEdits: 0,
  cellTyping: 0,
  appends: 0,
  intentionalDeletes: 0,
  serverRequests: 0,
  serverAccepted: 0,
  staleAccepted: 0,
  rejectedDeleted: 0,
  rejectedReplaced: 0,
  rejectedChanged: 0,
  offlineEdits: 0,
  offlineStructureBlocked: 0,
  deliveries: 0,
  duplicates: 0,
  reordered: 0,
  pending: 0,
  receiptDeferred: 0,
  receipts: 0,
  undo: 0,
  redo: 0,
  retainedColumns: 0,
  noOpUndo: 0,
  jobs: 0,
  repairPlans: 0,
  repairPublications: 0,
  repairCasConflicts: 0,
  rawBroken: 0,
  rawExtras: 0,
  rawEmailMissing: 0,
  settledBroken: 0,
  settledExtras: 0,
  settledEmailMissing: 0,
  requiredCheckStates: 0,
  insertionOnlyProofs: 0,
  convergenceChecks: 0,
  tokenChecks: 0,
  recoveryRequired: 0,
  recoveryChecks: 0,
});
type Coverage = ReturnType<typeof counters>;
type Replica = {
  doc: Y.Doc;
  origin: object;
  manager: Y.UndoManager;
  receipt: ReturnType<typeof createSharedTextActionHistory>;
  undo: Frame[];
  redo: Frame[];
  covered: number;
  delivered: Set<number>;
  recoveryText?: string;
};

class ScheduleCase {
  readonly errors = new Set<string>();
  readonly witnesses: unknown[] = [];
  readonly trace: unknown[] = [];
  readonly networkTail: unknown[] = [];
  readonly coverage = counters();
  readonly events: TopicEvent<SharedTextSyncEvent>[] = [];
  readonly packets: Packet[] = [];
  readonly outbox: { replica: number; update: Uint8Array; baseCursor: string | null; effects?: Effects }[] = [];
  readonly confirmed = new Map<string, Token>(baseMarks.map((ch) => [ch, { created: true, deletions: 0, owner: -1 }]));
  readonly recovery: { text: string; updates: { update: Uint8Array; baseCursor: string | null }[]; liveTokens: string[] }[] = [];
  nextReopenClient = 500;
  readonly queued: JobSubmit<SharedTextSnapshotRequest>[] = [];
  readonly tokens = new Map<string, Token>(baseMarks.map((ch) => [ch, { created: true, deletions: 0, owner: -1 }]));
  readonly replicas: Replica[];
  readonly documents: ReturnType<typeof bindDocuments<void, unknown>>;
  readonly pipeline: ReturnType<typeof sharedText.snapshots>;
  readonly topic: Pick<Topic<SharedTextSyncEvent>, "publish" | "cursorAt" | "cursorSequence" | "head" | "latestCursor" | "replay">;
  readonly saves: { cursor: string; text: string }[] = [];
  readonly observed: (string | undefined)[] = [];
  readonly online = [true, true, true];
  stored: SharedTextStoredState;
  handler?: (context: JobContext<SharedTextSnapshotRequest>) => Promise<void>;
  nextToken = 0xe100;
  actionNumber = 0;
  activeJobs = 0;
  maxActiveJobs = 0;
  repairPlanning = false;
  // An actual local update can race a repair's expectedAfter publication.
  raceRepair?: () => Promise<void>;

  constructor(
    readonly seed: number,
    readonly profile: Profile,
  ) {
    const base = new Y.Doc();
    base.clientID = 17;
    base.getText(SHARED_TEXT_NAME).insert(0, INITIAL);
    this.stored = { state: Y.encodeStateAsUpdate(base), text: INITIAL, cursor: null, restoreRevision: REVISION };
    base.destroy();
    this.replicas = [101, 202, 303].map((clientID) => {
      const doc = createDoc(this.stored);
      doc.clientID = clientID;
      const origin = {};
      const manager = new Y.UndoManager(doc.getText(SHARED_TEXT_NAME), { trackedOrigins: new Set([origin]), captureTimeout: 0 });
      return {
        doc,
        origin,
        manager,
        receipt: createSharedTextActionHistory(doc, manager, undefined, () => this.coverage.retainedColumns++),
        undo: [] as Frame[],
        redo: [] as Frame[],
        covered: 0,
        delivered: new Set<number>(),
      };
    });
    const publish = async (input: TopicPublish<SharedTextSyncEvent>) => {
      if (this.repairPlanning && this.raceRepair) {
        const race = this.raceRepair;
        this.raceRepair = undefined;
        await race();
      }
      const latest = this.events.at(-1)?.cursor ?? null;
      if (Object.hasOwn(input, "expectedAfter") && input.expectedAfter !== latest) {
        if (this.repairPlanning) this.coverage.repairCasConflicts++;
        throw new ConflictError("head changed");
      }
      const seq = this.events.length + 1;
      const entry: TopicEvent<SharedTextSyncEvent> = {
        cursor: cursor(seq),
        sequence: seq,
        eventId: `event-${seq}`,
        tenantId: DOC,
        publishedAt: new Date(NOW + seq),
        data: input.data,
      };
      this.events.push(entry);
      for (let to = 0; to < 3; to++) this.packets.push({ to, entry });
      if (this.repairPlanning) {
        this.check(input.expectedAfter === latest, "repair.notCasFenced");
        this.coverage.repairPublications++;
      }
      return { cursor: entry.cursor, eventId: entry.eventId, messageId: entry.eventId, streamSequence: seq, duplicate: false };
    };
    const owner = this;
    this.topic = {
      publish,
      cursorAt: cursor,
      cursorSequence: sequence,
      head: async () => cursor(this.events.length),
      latestCursor: async () => this.events.at(-1)?.cursor ?? null,
      replay: async function* (options: NonNullable<Parameters<Topic<SharedTextSyncEvent>["replay"]>[0]> = {}) {
        for (const entry of owner.events.slice(sequence(options.after ?? null), sequence(options.until ?? cursor(owner.events.length))))
          if (!options.tenantId || options.tenantId === entry.tenantId) yield entry;
      },
    };
    const save = async (_docId: string, input: SharedTextSaveInput) => {
      this.check(input.restoreRevision === this.stored.restoreRevision, "store.lineageChanged");
      if (sequence(input.cursor) < sequence(this.stored.cursor)) return;
      this.stored = { state: input.state, text: input.text, cursor: input.cursor, restoreRevision: input.restoreRevision };
      this.saves.push({ cursor: input.cursor, text: input.text });
    };
    const store: SharedTextSnapshotStore = {
      load: async () => this.stored,
      save,
      list: async () => [{ docId: DOC, cursor: this.stored.cursor }],
      recover: async () => {
        throw new Error("Unexpected history recovery in complete unit transport");
      },
      advance: async () => false,
    };
    this.documents = bindDocuments(
      {
        topic: () => this.topic,
        events: async function* (_docId, after, until) {
          const exact = after === until;
          yield* owner.events.slice(exact ? sequence(until) - 1 : sequence(after), sequence(until));
        },
        replay: async ({ doc, after, until, restoreRevision }) => {
          for await (const entry of this.topic.replay({ tenantId: DOC, after: after ?? cursor(0), until }))
            applySharedTextEvent(doc, entry, DOC, restoreRevision);
          return [];
        },
      },
      { load: store.load, save },
    );
    for (let replica = 0; replica < this.replicas.length; replica++) this.bindInverse(replica);
    const worker: Worker = { active: 0, capacity: 1, stop() {}, drain: async () => {}, [Symbol.asyncDispose]: async () => {} };
    const job: Pick<Job<SharedTextSnapshotRequest>, "submit" | "process"> = {
      submit: async (request) => {
        this.check(request.orderingKey === DOC && request.coalesce === true, "job.orderingContract");
        if (!this.queued.some((entry) => entry.key === request.key)) this.queued.push(request);
        return { messageId: "job", streamSequence: 1, duplicate: false, jobId: "job" };
      },
      process: async (options, handler) => {
        this.check(options.concurrency === 1, "job.concurrencyContract");
        this.handler = handler;
        return worker;
      },
    };
    this.pipeline = sharedText.snapshots({
      log: { id: "gate1", topic: () => this.topic, firstSequence: async () => 1 },
      store,
      job: () => job,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      repair: {
        maxLength: LIMIT,
        plan: (source) => {
          this.repairPlanning = true;
          const changes = repairTables(source, LIMIT);
          this.coverage.repairPlans++;
          this.check(
            changes.every((change) => change.from === change.to),
            "repair.deletedSource",
          );
          if (changes.length) {
            const next = T.applyChanges(source, changes);
            this.check(marks(source).join("") === marks(next).join(""), "repair.changedTokenOrder");
            this.coverage.insertionOnlyProofs++;
            this.trace.push({ repair: changes });
          }
          return changes;
        },
      },
    });
  }

  bindInverse(replica: number) {
    this.replicas[replica]!.receipt.setInverseHandler(async (request) => {
      const result = await this.documents.inverse(DOC, {
        actor: { kind: "user", id: `replica-${replica}` },
        actionId: request.actionId,
        receiptCursor: request.receiptCursor,
        restoreRevision: REVISION,
        maxLength: LIMIT,
      });
      if (result.status !== "edited") throw new Error(`Structural inverse failed: ${result.status}`);
      for (const packet of [...this.packets].filter((packet) => packet.to === replica && packet.entry.sequence <= sequence(result.cursor)))
        this.deliver(packet);
    });
  }
  confirm(effects: Effects) {
    for (const { token, value } of effects.created) {
      if (!this.confirmed.has(token)) this.confirmed.set(token, { ...this.tokens.get(token)!, created: false, deletions: 0 });
      this.confirmed.get(token)!.created = value;
    }
    for (const { token, delta } of effects.deleted) {
      this.check(this.confirmed.has(token), "oracle.confirmedDeletionWithoutCreation", token);
      if (this.confirmed.has(token)) this.confirmed.get(token)!.deletions += delta;
    }
  }
  async preserveAndReopen(replica: number) {
    const r = this.replicas[replica]!;
    const pending = this.outbox.filter((packet) => packet.replica === replica);
    const affected = new Set(
      pending.flatMap((packet) => [
        ...(packet.effects?.created.map((effect) => effect.token) ?? []),
        ...(packet.effects?.deleted.map((effect) => effect.token) ?? []),
      ]),
    );
    const liveTokens = [...affected].filter((ch) => {
      const token = this.tokens.get(ch)!;
      const accepted = this.confirmed.get(ch);
      return token.created && token.deletions === 0 && !(accepted?.created && accepted.deletions === 0);
    });
    const recovery = {
      text: r.recoveryText ?? this.text(replica),
      updates: pending.map((packet) => ({ update: packet.update.slice(), baseCursor: packet.baseCursor })),
      liveTokens,
    };
    for (const [index, packet] of pending.entries()) {
      this.check(toBase64(recovery.updates[index]!.update) === toBase64(packet.update), "recovery.changedPendingBytes");
      Y.decodeUpdate(recovery.updates[index]!.update);
      this.outbox.splice(this.outbox.indexOf(packet), 1);
    }
    this.recovery.push(recovery);
    for (const ch of affected) {
      const expected = this.confirmed.get(ch);
      const token = this.tokens.get(ch)!;
      token.created = expected?.created ?? false;
      token.deletions = expected?.deletions ?? 0;
    }
    // Model the existing explicit copy/reopen flow. The discarded local Y.Doc
    // is NEVER treated as a covering snapshot or automatically resubmitted.
    const snapshot = (await this.documents.read(DOC))!;
    r.receipt.dispose();
    r.manager.destroy();
    r.doc.destroy();
    const doc = createDoc(snapshot);
    doc.clientID = this.nextReopenClient++;
    const origin = {};
    const manager = new Y.UndoManager(doc.getText(SHARED_TEXT_NAME), { trackedOrigins: new Set([origin]), captureTimeout: 0 });
    this.replicas[replica] = {
      doc,
      origin,
      manager,
      receipt: createSharedTextActionHistory(doc, manager, undefined, () => this.coverage.retainedColumns++),
      undo: [],
      redo: [],
      covered: this.events.length,
      delivered: new Set(this.events.map((entry) => entry.sequence)),
    };
    this.bindInverse(replica);
    for (const packet of [...this.packets])
      if (packet.to === replica && packet.entry.sequence <= this.events.length) this.packets.splice(this.packets.indexOf(packet), 1);
    this.coverage.recoveryRequired++;
    this.trace.push({ recoveryRequired: replica, pending: pending.length, tokens: liveTokens });
  }

  text(replica = 0) {
    return this.replicas[replica]!.doc.getText(SHARED_TEXT_NAME).toString();
  }
  check(ok: unknown, error: string, detail?: unknown) {
    if (ok || this.errors.has(error)) return;
    this.errors.add(error);
    // One bounded first witness per invariant, plus the reproducible seed/CLI.
    this.witnesses.push({ error, detail, actions: this.trace.slice(-8), network: [...this.networkTail] });
  }
  network(event: unknown) {
    this.networkTail.push(event);
    if (this.networkTail.length > 8) this.networkTail.shift();
  }
  record(replica: number, label: string, intent: Intent) {
    const history = this.replicas[replica]!;
    history.manager.stopCapturing();
    history.undo.push({ ...intent, label });
    history.redo = [];
    for (const ch of intent.added) {
      this.check(!this.tokens.has(ch), "oracle.reusedToken");
      this.tokens.set(ch, { created: true, deletions: 0, owner: replica });
    }
    for (const ch of intent.removed) {
      const token = this.tokens.get(ch);
      this.check(token, "oracle.deletedUnknownToken");
      if (token) token.deletions++;
    }
    this.coverage.intentionalDeletes += intent.removed.length;
  }
  /** Local cell/append edits only. Server actions never pass through this. */
  edit(replica: number, changes: T.Change[], label: string, intent = emptyIntent()) {
    if (!changes.length) return;
    const r = this.replicas[replica]!;
    const before = this.text(replica);
    const next = T.applyChanges(before, changes);
    const delta = (a: string, b: string) =>
      marks(a)
        .filter((ch) => !marks(b).includes(ch))
        .sort()
        .join("");
    this.check(
      delta(next, before) === [...intent.added].sort().join("") && delta(before, next) === [...intent.removed].sort().join(""),
      "oracle.editOutsideIntent",
      { label, intent },
    );
    const vector = Y.encodeStateVector(r.doc);
    r.manager.stopCapturing();
    r.doc.transact(() => {
      for (const change of [...changes].sort((a, b) => b.from - a.from || b.to - a.to)) {
        const text = r.doc.getText(SHARED_TEXT_NAME);
        if (change.to > change.from) text.delete(change.from, change.to - change.from);
        if (change.insert) text.insert(change.from, change.insert);
      }
    }, r.origin);
    this.check(this.text(replica) === next, "local.transactionMismatch");
    this.outbox.push({
      replica,
      update: Y.encodeStateAsUpdate(r.doc, vector),
      baseCursor: r.covered ? cursor(r.covered) : null,
      effects: effectsOf(intent),
    });
    this.record(replica, label, intent);
    r.recoveryText = this.text(replica);
    this.coverage.localEdits++;
    if (!this.online[replica]) this.coverage.offlineEdits++;
    this.trace.push({ local: label, replica, changes, intent });
    this.observe(replica);
  }
  type(replica: number, pick: number, literal?: string) {
    const table = T.findTables(this.text(replica))[0];
    if (!table) {
      this.trace.push({ unavailable: "cell", replica });
      return;
    }
    // Same pick arithmetic as the retained model counterexample.
    const row = pick % 3 === 0 ? 1 : pick % T.rowCount(table);
    const column = pick % 3 === 0 ? 0 : Math.floor(pick / 3) % table.columns;
    const cell = T.gridLine(table, row)?.cells[column];
    if (!cell) return;
    const token = String.fromCharCode(this.nextToken++);
    const shown = T.displayCell(cell.text);
    const boundaries = [0];
    for (const ch of shown) boundaries.push(boundaries.at(-1)! + ch.length);
    const at = boundaries[Math.floor(pick / 7) % boundaries.length]!;
    const inserted = token + (literal ?? ["", "", "", "", "|", "\\", "\\|", "😀"][pick % 8]!);
    const next = shown.slice(0, at) + inserted + shown.slice(at);
    const changes = T.cellChanges(cell.text, next, cell.from);
    const result = T.findTables(T.applyChanges(this.text(replica), changes))[0];
    this.check(result && T.displayCell(T.gridLine(result, row)?.cells[column]?.text ?? "") === next, "cell.displayRoundtrip");
    this.edit(replica, changes, "type", { added: [token], removed: [] });
    this.coverage.cellTyping++;
  }
  append(replica: number) {
    const table = T.findTables(this.text(replica))[0];
    if (!table) return;
    this.edit(replica, T.insertRow(table, T.rowCount(table) - 1), "append");
    this.coverage.appends++;
  }
  deleteOwn(replica: number) {
    const token = marks(this.text(replica)).find((ch) => this.tokens.get(ch)?.owner === replica);
    if (!token) return;
    const at = this.text(replica).indexOf(token);
    this.edit(replica, [{ from: at, to: at + 1, insert: "" }], "delete-own", { added: [], removed: [token] });
  }
  async undo(replica: number, redo = false) {
    const r = this.replicas[replica]!;
    const frame = (redo ? r.redo : r.undo).pop();
    this.trace.push({ [redo ? "redo" : "undo"]: replica, frame: frame?.label ?? "empty" });
    if (!frame) return;
    const vector = Y.encodeStateVector(r.doc);
    const structural = r.receipt.nextStructural(redo ? "redo" : "undo");
    // A structural receipt also delivers withheld peer events. Compare its
    // authoritative before/after state; equal local bytes can represent two
    // DIFFERENT empty columns (seed9). Native frames still compare locally.
    const before = structural ? (await this.documents.read(DOC))!.text : this.text(replica);
    const retainedBefore = this.coverage.retainedColumns;
    const fromSize = redo ? r.receipt.redoDepth() : r.receipt.undoDepth();
    const toSize = redo ? r.receipt.undoDepth() : r.receipt.redoDepth();
    const item = await (redo ? r.receipt.redo() : r.receipt.undo());
    this.check(item, "history.missingItem", frame);
    this.check(
      (redo ? r.receipt.redoDepth() : r.receipt.undoDepth()) === fromSize - 1 &&
        (redo ? r.receipt.undoDepth() : r.receipt.redoDepth()) === toSize + 1,
      "history.skippedFrame",
      frame,
    );
    const after = structural ? (await this.documents.read(DOC))!.text : this.text(replica);
    if (!redo && after === before) {
      this.coverage.noOpUndo++;
      // A retained insertion still consumes exactly its own history frame.
      // Its declared intent has no content tokens; never silently exempt a
      // typing/deletion frame from the independent character oracle.
      this.check(frame.added.length === 0 && frame.removed.length === 0, "history.protectedContentIntent", frame);
      this.check(this.coverage.retainedColumns > retainedBefore, "history.unexplainedNoOp", frame);
      this.trace.push({ noOpUndo: replica, label: frame.label });
    }
    (redo ? r.undo : r.redo).push(frame);
    for (const ch of frame.added) this.tokens.get(ch)!.created = redo;
    for (const ch of frame.removed) this.tokens.get(ch)!.deletions += redo ? 1 : -1;
    const effects = effectsOf(frame, redo, redo ? 1 : -1);
    if (!structural)
      this.outbox.push({
        replica,
        update: Y.encodeStateAsUpdate(r.doc, vector),
        baseCursor: r.covered ? cursor(r.covered) : null,
        effects,
      });
    else this.confirm(effects);
    r.recoveryText = this.text(replica);
    this.coverage[redo ? "redo" : "undo"]++;
    this.observe(replica);
  }
  async upload(replica?: number) {
    for (const packet of [...this.outbox]) {
      if (!this.outbox.includes(packet)) continue;
      if ((replica !== undefined && packet.replica !== replica) || !this.online[packet.replica]) continue;
      const beforeEvents = this.events.length;
      const admitted = await this.documents.accept(DOC, {
        actor: { kind: "user", id: `replica-${packet.replica}` },
        update: packet.update,
        baseCursor: packet.baseCursor,
        restoreRevision: REVISION,
        originNodeId: `replica-${packet.replica}`,
        originPeerId: null,
      });
      if (admitted.status !== "accepted") {
        this.check(admitted.status === "recoveryRequired", "ingress.unavailableDocument");
        this.check(this.events.length === beforeEvents, "ingress.rejectionPublished");
        await this.preserveAndReopen(packet.replica);
        continue;
      }
      if (packet.effects) this.confirm(packet.effects);
      this.outbox.splice(this.outbox.indexOf(packet), 1);
    }
  }
  deliver(packet: Packet) {
    if (!this.online[packet.to]) return false;
    const r = this.replicas[packet.to]!;
    if (this.packets.some((candidate) => candidate.to === packet.to && candidate.entry.sequence < packet.entry.sequence))
      this.coverage.reordered++;
    const update = fromBase64(packet.entry.data.payload);
    // The production provider uploads local history bookkeeping and any late
    // dependency restoration emitted while applying a remote receipt. Model
    // that same seam; suppress only remote/echo origins, not local corrections.
    const localUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin !== "remote" && !r.receipt.isRemoteOrigin(origin))
        this.outbox.push({ replica: packet.to, update, baseCursor: r.covered ? cursor(r.covered) : null });
    };
    r.doc.on("update", localUpdate);
    try {
      r.receipt.apply(update, packet.entry.data.actionId, packet.entry.cursor, packet.entry.data.history?.retained);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "The table action is missing preceding updates") throw error;
      this.coverage.receiptDeferred++;
      this.network({ deferredReceipt: packet.entry.sequence, to: packet.to });
      return false; // Keep bytes queued; never silently mark an untracked receipt covered.
    } finally {
      r.doc.off("update", localUpdate);
    }
    if (r.doc.store.pendingStructs || r.doc.store.pendingDs) this.coverage.pending++;
    const beforeDuplicate = this.text(packet.to);
    r.receipt.apply(update, packet.entry.data.actionId, packet.entry.cursor, packet.entry.data.history?.retained);
    this.check(this.text(packet.to) === beforeDuplicate, "transport.duplicateChangedText");
    r.delivered.add(packet.entry.sequence);
    while (r.delivered.has(r.covered + 1)) r.covered++;
    this.packets.splice(this.packets.indexOf(packet), 1);
    this.network({ deliver: packet.entry.sequence, to: packet.to, duplicate: true });
    this.coverage.deliveries++;
    this.coverage.duplicates++;
    this.observe(packet.to);
    return true;
  }
  deliverAll(reverse = true) {
    while (this.packets.some((packet) => this.online[packet.to])) {
      const candidates = this.packets.filter((packet) => this.online[packet.to]);
      let progress = false;
      for (const packet of reverse ? candidates.reverse() : candidates) if (this.deliver(packet)) progress = true;
      if (!progress) throw new Error("Receipt delivery stalled without causal prerequisites");
    }
  }
  observe(replica: number) {
    const text = this.text(replica);
    if (text === this.observed[replica]) return;
    this.observed[replica] = text;
    const state = inspectTable(text);
    this.coverage.rawExtras += state.extras;
    this.coverage.rawEmailMissing += state.emailMissing.length;
    this.check(text.startsWith("Before\n\n") && text.endsWith("\n\nAfter"), "surroundingProseChanged");
    if (state.broken) {
      this.coverage.rawBroken++;
      this.assertCheckAndRefusal(text, replica, "raw");
    }
  }
  assertCheckAndRefusal(text: string, replica: number, phase: "raw" | "settled") {
    this.coverage.requiredCheckStates++;
    const issue = inspectTableStructure(text);
    this.check(issue.extraCells || issue.missingSeparator, "production.tableCheckStateMissing", { phase, replica, text });
    const rendered = renderComposeContent({
      body: text,
      format: "markdown",
      customCss: "",
      renderLiquid: false,
      context: composeContext,
    });
    const error = !rendered.ok ? rendered.error : undefined;
    const detail = error && "composeRender" in error ? error.composeRender : undefined;
    const reason = detail && typeof detail === "object" && "reason" in detail ? detail.reason : undefined;
    // Real preview/send renderer refusal, not a harness-only boolean. DOM
    // indication and final send ordering require separate browser/integration proof.
    this.check(reason === "tableNeedsReview" || reason === "tableSeparatorNeedsReview", "production.sendGuardMissing", {
      phase,
      replica,
      text,
      reason,
    });
  }

  capture(replica: number, action: MenuAction, row = 1, column = 0) {
    const table = T.findTables(this.text(replica))[0];
    if (!table) throw new TableActionRejectedError();
    return captureTableAction(this.replicas[replica]!.doc.getText(SHARED_TEXT_NAME), action, {
      tableFrom: table.from,
      row,
      column,
      rowFrom: T.gridLine(table, row)!.from,
      columnFrom: table.lines[0]!.cells[Math.min(column, table.columns - 1)]!.from,
    });
  }
  async action(
    replica: number,
    intent: TableActionIntent,
    removed: string[] = [],
    expected: "accept" | "changed" | "deleted" | "replaced" = "accept",
  ) {
    if (!this.online[replica]) {
      this.coverage.offlineStructureBlocked++;
      return;
    }
    this.coverage.serverRequests++;
    const r = this.replicas[replica]!;
    const actionId = `action-${++this.actionNumber}`;
    const pending = r.receipt.begin(actionId);
    const beforeEvents = this.events.length;
    this.trace.push({ server: intent.action, replica, actionId, expected, removed });
    try {
      const result = await this.documents.change(
        DOC,
        { actor: { kind: "user", id: `replica-${replica}` }, actionId, maxLength: LIMIT },
        (current) => {
          const doc = new Y.Doc();
          try {
            Y.applyUpdate(doc, current.state());
            return planTableAction(doc.getText(SHARED_TEXT_NAME), intent, LIMIT);
          } finally {
            doc.destroy();
          }
        },
      );
      this.check(expected === "accept" || expected === "changed", "anchor.acceptedDeletedOrReplaced", { expected, action: intent.action });
      if (result.status === "unchanged") {
        pending.cancel(new Error("unchanged"));
        return;
      }
      this.check(result.status === "edited" && result.receipt, "action.writeFailed", result.status);
      if (result.status !== "edited" || !result.receipt) {
        pending.cancel(new Error(result.status));
        return;
      }
      const receipt = result.receipt;
      const event = this.events.find((entry) => entry.data.actionId === actionId);
      this.check(event && toBase64(receipt.update) === event.data.payload, "receipt.transportMismatch");
      // Deliberately try the HTTP receipt before prerequisites; the real
      // history seam must defer it. Then replay the real preceding log events.
      const receiptPacket = this.packets.find((packet) => packet.to === replica && packet.entry === event);
      if (receiptPacket) this.deliver(receiptPacket);
      for (const packet of [...this.packets].filter((packet) => packet.to === replica && packet.entry.sequence <= sequence(result.cursor)))
        this.deliver(packet);
      await pending.applied;
      this.check(!r.receipt.hasPending(), "receipt.pendingAfterDelivery");
      this.record(replica, intent.action, { added: [], removed });
      this.confirm(effectsOf({ added: [], removed }));
      this.coverage.receipts++;
      this.coverage.serverAccepted++;
    } catch (error) {
      pending.cancel(error);
      if (!(error instanceof TableActionRejectedError)) throw error;
      this.check(expected !== "accept", "anchor.rejectedLiveTarget");
      this.check(this.events.length === beforeEvents, "anchor.rejectionPublished");
      if (expected === "deleted") this.coverage.rejectedDeleted++;
      if (expected === "replaced") this.coverage.rejectedReplaced++;
      if (expected === "changed") this.coverage.rejectedChanged++;
    }
  }
  async repair() {
    await this.pipeline.start();
    await this.pipeline.queue({ docId: DOC, targetCursor: cursor(this.events.length), reason: "gate1" });
    while (this.queued.length) {
      const request = this.queued.shift()!;
      // The actual handler comes from sharedText.snapshots.start/process.
      // FIFO models orderingKey; distributed lease/partition proof is NATS-only.
      for (let attempt = 1; ; attempt++) {
        const context: JobContext<SharedTextSnapshotRequest> = {
          jobId: "job",
          key: request.key,
          input: request.input,
          attempt,
          failureCount: attempt - 1,
          signal: new AbortController().signal,
          heartbeat: async () => {},
          resubmit() {},
        };
        this.activeJobs++;
        this.maxActiveJobs = Math.max(this.maxActiveJobs, this.activeJobs);
        try {
          await this.handler!(context);
          this.coverage.jobs++;
          break;
        } catch (error) {
          if (!(error instanceof ConflictError) || attempt >= 20) throw error; // Actual snapshot job maxAttempts.
        } finally {
          this.activeJobs--;
          this.repairPlanning = false;
        }
      }
    }
  }
  async settle() {
    // Delivery can trigger one late-dependency restoration per column receipt.
    // Drain its real local update through the same ordered repair writer before
    // declaring recovery settled. A stalled recovery is still a gate failure.
    let passes = this.coverage.receipts + 1;
    do {
      if (passes-- === 0) throw new Error("History recovery did not settle within the accepted receipt count");
      await this.upload();
      await this.repair();
      this.deliverAll();
    } while (this.outbox.length);
    for (const recovery of this.recovery) {
      for (const token of recovery.liveTokens)
        this.check(marks(recovery.text).filter((value) => value === token).length === 1, "recovery.inputNotReadable", {
          token,
          text: recovery.text,
        });
      this.check(recovery.updates.length > 0, "recovery.pendingBytesMissing");
      this.coverage.recoveryChecks++;
    }
    const snapshot = await this.documents.read(DOC);
    const texts = this.replicas.map((_, i) => this.text(i));
    this.check(new Set(texts).size === 1 && snapshot?.text === texts[0], "convergence.text");
    const vectors = this.replicas.map((r) => toBase64(Y.encodeStateVector(r.doc)));
    this.check(new Set(vectors).size === 1, "convergence.vector");
    if (snapshot) {
      const persisted = createDoc(snapshot);
      try {
        this.check(
          persisted.getText(SHARED_TEXT_NAME).toString() === texts[0] && toBase64(Y.encodeStateVector(persisted)) === vectors[0],
          "convergence.persistedBinary",
        );
      } finally {
        persisted.destroy();
      }
    }
    this.check(
      this.replicas.every((r) => !r.doc.store.pendingStructs && !r.doc.store.pendingDs),
      "convergence.pending",
    );
    this.coverage.convergenceChecks++;
    for (const [replica, text] of texts.entries()) {
      const state = inspectTable(text);
      const counts = new Map<string, number>();
      for (const ch of marks(text)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
      for (const [ch, token] of this.tokens) {
        const confirmed = this.confirmed.get(ch);
        this.check(
          token.created === (confirmed?.created ?? false) && token.deletions === (confirmed?.deletions ?? 0),
          "oracle.pendingIntentAtSettle",
          ch,
        );
        const expected = Number(token.created && token.deletions === 0);
        this.check((counts.get(ch) ?? 0) === expected, "tokens.lossOrUnexpectedResurrection", {
          replica,
          token: ch,
          expected,
          actual: counts.get(ch) ?? 0,
        });
        // Grid cells or the visible Markdown fallback expose every surviving token.
        const visible = marks(state.visible).filter((value) => value === ch).length;
        this.check(visible === expected, "tokens.notVisible", { replica, token: ch, expected, visible });
      }
      this.check(
        [...counts.keys()].every((ch) => this.tokens.has(ch)),
        "tokens.unknownIdentity",
      );
      this.coverage.tokenChecks++;
      this.coverage.settledExtras += state.extras;
      this.coverage.settledEmailMissing += state.emailMissing.length;
      this.check(state.emailMissing.length === 0, "email.visibleTokenLoss", { replica, tokens: state.emailMissing, text });
      if (state.broken) {
        this.coverage.settledBroken++;
        this.assertCheckAndRefusal(text, replica, "settled");
        if (this.profile !== "adversarial") this.check(false, "realistic.settledBroken", { replica, text });
      }
    }
    this.check(this.outbox.length === 0 && this.packets.length === 0, "transport.undeliveredAtSettle");
    this.check(this.maxActiveJobs === 1, "repair.concurrentWriters");
    // Anti-entropy is an assertion, never a substitute for delivering packets.
    for (const source of this.replicas)
      for (const target of this.replicas) {
        const before = target.doc.getText(SHARED_TEXT_NAME).toString();
        Y.applyUpdate(target.doc, Y.encodeStateAsUpdate(source.doc, Y.encodeStateVector(target.doc)), "remote");
        this.check(target.doc.getText(SHARED_TEXT_NAME).toString() === before, "convergence.antiEntropyChangedText");
      }
  }
  async destroy() {
    await this.pipeline.stop();
    for (const r of this.replicas) {
      r.receipt.dispose();
      r.manager.destroy();
      r.doc.destroy();
    }
  }
}

/** Exact retained four-action witness; repair happens AFTER the raw check. */
async function appendUndo(run: ScheduleCase) {
  run.append(0);
  await run.upload(0);
  run.deliverAll(false);
  run.type(1, 19, "");
  await run.undo(0);
  // Upload the original counterexample unchanged. A THIRD replica's independent
  // typing update below races the repair's expectedAfter publication.
  await run.upload(0);
  await run.upload(1);
  run.deliverAll();
  const raw = inspectTable(run.text());
  run.trace.push({ seed208BeforeRepair: run.text(), extras: raw.extras, broken: raw.broken });
  run.type(2, 0, "race");
  run.raceRepair = async () => {
    // Avoid labelling this local upload as a repair publication.
    run.repairPlanning = false;
    await run.upload(2);
    run.repairPlanning = true;
  };
  await run.repair();
  run.deliverAll();
  await run.settle();
  // A successful prevention must not be required to produce damage merely
  // to exercise repair. Keep damage/repair counters as diagnostic evidence;
  // dedicated repair tests cover publication CAS and insertion-only plans.
  await run.undo(0, true);
  await run.settle();
  run.type(1, 0, "peer-after-repair");
  await run.settle();
  await run.undo(0);
  await run.settle();
  await run.undo(0, true);
  await run.settle();
  // Own server receipt remains a separate undo item after actual repair and
  // another replica's edit. Repair must never enter the user's undo history.
  await run.action(0, run.capture(0, "alignRight", 1, 1));
  await run.settle();
  run.type(1, 0, "after-server-receipt");
  await run.settle();
  await run.undo(0);
  await run.settle();
  await run.undo(0, true);
  await run.settle();
}

async function anchors(run: ScheduleCase) {
  // The server receipt depends on an update this requesting replica has not
  // received. The real history implementation must refuse premature capture.
  // A separator-only alignment can be causally independent of a missing cell
  // edit. Inserting a column in the peer's NEW row requires that row's items.
  const waiting = run.capture(0, "colRight", 1, 2);
  run.append(1);
  await run.upload(1);
  await run.action(0, waiting);
  await run.settle();
  run.check(run.coverage.receiptDeferred > 0, "coverage.receiptCausalDeferralMissing");
  // Capture before shifting the target by an inserted preceding column.
  const stale = run.capture(0, "alignRight", 1, 1);
  await run.action(1, run.capture(1, "colLeft", 1, 0));
  await run.settle();
  await run.action(0, stale);
  run.coverage.staleAccepted++;
  await run.settle();
  const table = T.findTables(run.text())[0]!;
  run.check(table.align[2] === "right" && table.align[1] !== "right", "anchor.driftedToNeighbour");
  // Undo own server receipt after another replica typed and repair ran.
  run.type(1, 4);
  await run.settle();
  await run.undo(0);
  await run.settle();
  await run.undo(0, true);
  await run.settle();
  const deleted = run.capture(0, "alignLeft", 1, 0);
  // This inserted empty column contains no token, so deletion has empty intent.
  await run.action(1, run.capture(1, "deleteCol", 1, 0));
  await run.settle();
  await run.action(0, deleted, [], "deleted");
  const replaced = run.capture(0, "alignLeft", 1, 0);
  const separator = T.findTables(run.text())[0]!.lines[1]!.cells[0]!;
  const at = separator.from + separator.text.indexOf("-");
  // Same-looking replacement: fixed character identity must still be rejected.
  run.edit(1, [{ from: at, to: at + 1, insert: "-" }], "replace-anchor-character");
  await run.settle();
  await run.action(0, replaced, [], "replaced");
  const deletedRow = run.capture(0, "rowBelow", 1, 0);
  const removed = T.gridLine(T.findTables(run.text())[0]!, 1)!.cells.flatMap((cell) => marks(cell.text));
  await run.action(1, run.capture(1, "deleteRow", 1, 0), removed);
  await run.settle();
  await run.action(0, deletedRow, [], "deleted");
  // Own deletion undo restores exactly the intentional tokens, not peer edits.
  await run.undo(1);
  await run.settle();
  await run.undo(1, true);
  await run.settle();
}

async function generated(run: ScheduleCase) {
  const random = randomFor(run.seed);
  const int = (n: number) => Math.floor(random() * n);
  run.online[2] = false;
  run.type(0, 0);
  run.type(0, 0);
  run.type(2, 0);
  await run.upload();
  // A dependent delta arrives before its prerequisite, not a full snapshot.
  const dependent = run.packets.filter((packet) => packet.to === 1).at(-1)!;
  run.deliver(dependent);
  run.type(1, 0);
  await run.action(2, run.capture(2, "rowBelow"));
  run.online[2] = true;
  await run.settle();
  // Explicit local deletion/undo/redo accounting, separate from structural loss.
  run.deleteOwn(0);
  await run.settle();
  await run.undo(0);
  await run.settle();
  await run.undo(0, true);
  await run.settle();
  for (let step = 0; step < 32; step++) {
    const replica = int(3),
      pick = int(4096),
      roll = int(100);
    if (roll < 46) run.type(replica, pick);
    else if (roll < 61) run.append(replica);
    else if (roll < 70) await run.undo(replica);
    else if (roll < 75) await run.undo(replica, true);
    else if (roll < 81) run.deleteOwn(replica);
    else if (roll < 88) {
      await run.upload();
      const packets = run.packets.filter((packet) => packet.to === replica);
      if (packets.length) run.deliver(packets[pick % packets.length]!);
    } else {
      // Structure requests are online and flush the caller's updates first.
      // Adversarial captures a stale request before a different server action.
      await run.upload();
      run.deliverAll();
      const table = T.findTables(run.text(replica))[0];
      if (!table) {
        run.trace.push({ unavailable: "structure", replica });
        continue;
      }
      const action = (["colLeft", "colRight", "rowAbove", "rowBelow", "alignLeft", "alignCenter", "alignRight"] as const)[pick % 7]!;
      const intent = run.capture(replica, action, pick % T.rowCount(table), Math.floor(pick / 7) % table.columns);
      if (run.profile === "adversarial") {
        await run.action((replica + 1) % 3, run.capture((replica + 1) % 3, "colLeft", 1, 0));
      }
      // Inserting beside a captured column can invalidate its fixed edge
      // witnesses without deleting the hyphen. Rejection is correct there;
      // deleted/replaced targets have separate mandatory-rejection probes.
      await run.action(replica, intent, [], run.profile === "adversarial" ? "changed" : "accept");
    }
    if (step % 8 === 7) await run.settle();
  }
  if (run.profile === "adversarial") {
    // Damage the actual separator while offline typing survives elsewhere.
    // Unrecognizable Markdown cannot be made safe by a harness-only send flag.
    run.online[2] = false;
    run.type(2, 0);
    const table = T.findTables(run.text(0))[0];
    if (table) {
      const separator = table.lines[1]!;
      run.edit(0, [{ from: separator.from, to: separator.to, insert: "| separator replaced |" }], "adversarial-separator");
    }
    run.online[2] = true;
  }
  await run.settle();
  run.check(run.coverage.offlineEdits > 0 && run.coverage.offlineStructureBlocked > 0, "coverage.offlineMissing");
  run.check(run.coverage.pending > 0 && run.coverage.reordered > 0 && run.coverage.duplicates > 0, "coverage.deliveryMissing");
}

export async function runGate1Case(seed: number, profile: Profile) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError("Invalid seed");
  let writerId = 1000;
  const transact = Y.Doc.prototype.transact;
  // Production createDoc uses random client IDs. Fix only IDs of documents
  // about to write through the ACTUAL server writer; no execution is replaced.
  const transactionSpy = spyOn(Y.Doc.prototype, "transact").mockImplementation(function <T>(
    this: Y.Doc,
    fn: (transaction: Y.Transaction) => T,
    origin?: unknown,
  ): T {
    if (origin === "cli-edit" || origin === "snapshot-repair") this.clientID = writerId++;
    const actual: (this: Y.Doc, fn: (transaction: Y.Transaction) => T, origin?: unknown) => T = transact;
    return actual.call(this, fn, origin);
  });
  const timeSpy = spyOn(Date, "now").mockReturnValue(NOW);
  let run: ScheduleCase | undefined;
  try {
    run = new ScheduleCase(seed, profile);
    try {
      if (profile === "append-undo") await appendUndo(run);
      else if (profile === "anchors") await anchors(run);
      else await generated(run);
    } catch (error) {
      run.check(false, "exception", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
    return {
      seed,
      profile,
      errors: [...run.errors],
      coverage: run.coverage,
      tokens: {
        surviving: [...run.tokens.values()].filter((token) => token.created && token.deletions === 0).length,
        intentionallyAbsent: [...run.tokens.values()].filter((token) => !token.created || token.deletions > 0).length,
      },
      witnesses: run.witnesses,
      trace: run.trace,
      text: run.text(),
      proof: {
        transport: "deterministic unit schedule",
        replicas: 3,
        writer: "bindDocuments.change",
        repair: "sharedText.snapshots + repairTables",
        history: "createSharedTextActionHistory + Y.UndoManager",
        email: "canonical email Markdown + outgoing sanitizer",
        finalMailCompose: "not covered",
        productionCheckAndSendGuard: "production structural predicate + Mail renderer refusal; DOM and send ordering separate",
        realNats: "not run",
      },
      reproduce: `bun --no-env-file packages/cloud/test/shared-text-table-fuzz.ts --cases 1 --start ${seed} --profile ${profile}`,
    };
  } finally {
    try {
      await run?.destroy();
    } finally {
      transactionSpy.mockRestore();
      timeSpy.mockRestore();
    }
  }
}

export type Gate1Result = Awaited<ReturnType<typeof runGate1Case>>;

const help = `Usage: bun --no-env-file packages/cloud/test/shared-text-table-fuzz.ts [--cases 1] [--start 1] [--profile both|realistic|adversarial|append-undo|anchors]

Deterministic UNIT schedules over the actual anchored action/ordered repair writers.
--cases counts seeds per selected profile; both runs realistic + adversarial.
Default: 2 total cases. Failure: bounded JSONL witness once per invariant/profile,
summary counts and nonzero exit. Original seed208 raw damage remains in evidence.
No automatic minimization reruns or services. Run long sweeps via scripts/heavy.ts.
Nightly 10,000 TOTAL: --cases 5000 --start 1 --profile both.
Final Mail send ordering, browser indication, provider and real-NATS proof remain separate.
`;

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) console.log(help);
  else {
    let cases = 1,
      start = 1,
      profile = "both";
    try {
      const seen = new Set<string>();
      for (let at = 0; at < args.length; at += 2) {
        const key = args[at]!,
          value = args[at + 1];
        if (!["--cases", "--start", "--profile"].includes(key) || seen.has(key) || value === undefined)
          throw new Error("Invalid arguments");
        seen.add(key);
        if (key === "--cases") cases = Number(value);
        if (key === "--start") start = Number(value);
        if (key === "--profile") profile = value;
      }
      if (
        !Number.isSafeInteger(cases) ||
        cases < 1 ||
        !Number.isSafeInteger(start) ||
        start < 0 ||
        start + cases > 0x100000000 ||
        !["both", "realistic", "adversarial", "append-undo", "anchors"].includes(profile)
      )
        throw new Error("Invalid cases/start/profile");
      const profiles: Profile[] = (["realistic", "adversarial", "append-undo", "anchors"] as const).filter((selected) =>
        profile === "both" ? selected === "realistic" || selected === "adversarial" : selected === profile,
      );
      for (const selected of profiles) {
        const coverage = counters();
        const failures = new Map<string, { count: number; seeds: number[] }>();
        let failedCases = 0,
          rawBrokenCases = 0,
          settledBrokenCases = 0,
          surviving = 0,
          intentionallyAbsent = 0;
        for (let seed = start; seed < start + cases; seed++) {
          const result = await runGate1Case(seed, selected);
          failedCases += Number(result.errors.length > 0);
          rawBrokenCases += Number(result.coverage.rawBroken > 0);
          settledBrokenCases += Number(result.coverage.settledBroken > 0);
          surviving += result.tokens.surviving;
          intentionallyAbsent += result.tokens.intentionallyAbsent;
          for (const key of Object.keys(coverage) as (keyof Coverage)[]) coverage[key] += result.coverage[key];
          const unseen = result.errors.filter((error) => !failures.has(error));
          if (unseen.length) console.error(JSON.stringify({ kind: "failure", ...result, firstInvariants: unseen }));
          for (const error of result.errors) {
            const entry = failures.get(error) ?? { count: 0, seeds: [] };
            entry.count++;
            if (entry.seeds.length < 8) entry.seeds.push(seed);
            failures.set(error, entry);
          }
        }
        console.log(
          JSON.stringify({
            kind: "summary",
            profile: selected,
            start,
            cases,
            failedCases,
            rawBrokenCases,
            settledBrokenCases,
            tokens: { surviving, intentionallyAbsent },
            coverage,
            failures: Object.fromEntries(failures),
          }),
        );
        if (failures.size) process.exitCode = 1;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      console.error(help);
      process.exitCode = 2;
    }
  }
}
