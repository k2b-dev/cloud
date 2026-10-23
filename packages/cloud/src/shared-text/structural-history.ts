/** Server-authored provenance. Read only from the authenticated document log. */
import * as T from "@k2b/ui/text-editor/model";
import * as Y from "yjs";
import { captureTextAnchor, resolveTextAnchor } from "./anchors";
import { fromBase64, toBase64 } from "./events";
import { TableActionRejectedError } from "./table-actions";
import type { SharedTextChange } from "./types";

type Run = { client: number; clock: number; length: number };
type Patch = {
  left: string | null;
  right: string | null;
  removed: string;
  inserted: string;
  added: Run | null;
  deleted: Run[];
  recreate?: true;
};
export type SharedTextStructuralHistory = {
  patches: Patch[];
  column?: { header: string; hyphen: string };
  tables: string[];
  retained?: boolean;
  inverseOf?: string;
  ingressBarrier?: boolean;
  /** Post-action schema/row identities fence generic restoration. */
  schemas?: { header: string; hyphens: string[]; rows: string[] }[];
};
const anchor = (text: Y.Text, at: number) => toBase64(captureTextAnchor(text, at));
const resolve = (text: Y.Text, encoded: string) => resolveTextAnchor(text, fromBase64(encoded));
const reject = (): never => {
  throw new TableActionRejectedError();
};

// Exported Yjs traversal visits identity runs, not one linked-list search per
// character. The transient snapshot is bounded by this document's state.
const runs = (text: Y.Text, from: number, to: number): Run[] => {
  const result: Run[] = [];
  const first = Y.createRelativePositionFromTypeIndex(text, from).item;
  if (from === to || !first || !text.doc) return result;
  let left = to - from;
  let item = Y.getItem(text.doc.store, first);
  let clock = first.clock;
  while (left > 0) {
    if (!item.deleted && item.countable) {
      const length = Math.min(left, item.id.clock + item.length - clock);
      result.push({ client: item.id.client, clock, length });
      left -= length;
    }
    if (!left) break;
    if (!item.right) return reject();
    item = item.right;
    clock = item.id.clock;
  }
  return result;
};

export const prepareStructuralHistory = (text: Y.Text, changes: readonly SharedTextChange[]) => {
  const source = text.toString();
  const tables = T.findTables(source);
  const previous = tables.map((table) => ({
    header: anchor(text, table.lines[0]!.to),
    hyphens: table.lines[1]!.cells.map((cell) => anchor(text, cell.from + cell.text.indexOf("-"))),
  }));
  const patches: Patch[] = changes.map((change) => ({
    left: change.from > 0 ? anchor(text, change.from - 1) : null,
    right: change.to < text.length ? anchor(text, change.to) : null,
    removed: source.slice(change.from, change.to),
    inserted: change.insert,
    added: null,
    deleted: runs(text, change.from, change.to),
    ...(change.recreate ? { recreate: true as const } : {}),
  }));
  const affected = tables
    .filter((table) => changes.some((change) => change.from <= table.to && change.to >= table.from))
    .map((table) => anchor(text, table.lines[0]!.to));
  return () => {
    let shift = 0;
    changes.forEach((change, index) => {
      if (change.insert.length) {
        const id = Y.createRelativePositionFromTypeIndex(text, change.from + shift).item!;
        patches[index]!.added = { client: id.client, clock: id.clock, length: change.insert.length };
      }
      shift += change.insert.length - (change.to - change.from);
    });
    const result: SharedTextStructuralHistory = { patches, tables: affected };
    result.schemas = T.findTables(text.toString())
      .filter((table) => affected.some((header) => resolve(text, header) === table.lines[0]!.to))
      .map((table) => ({
        header: anchor(text, table.lines[0]!.to),
        hyphens: table.lines[1]!.cells.map((cell) => anchor(text, cell.from + cell.text.indexOf("-"))),
        rows: table.lines.slice(2).map((line) => anchor(text, line.pipes[0] ?? line.from)),
      }));
    if (changes.every((change) => change.from === change.to)) {
      for (const table of T.findTables(text.toString())) {
        const before = previous.find((old) => resolve(text, old.header) === table.lines[0]!.to);
        if (!before || table.columns !== before.hyphens.length + 1) continue;
        const old = before.hyphens.map((value) => resolve(text, value));
        const current = table.lines[1]!.cells.map((cell) => cell.from + cell.text.indexOf("-"));
        if (!old.every((at) => at !== null && current.includes(at))) continue;
        const at = current.find((at) => !old.includes(at))!;
        result.column = { header: before.header, hyphen: anchor(text, at) };
        break;
      }
    }
    return result;
  };
};

/** No mutation; a changed/deleted fixed target rejects rather than guessing. */
export const planStructuralInverse = (
  text: Y.Text,
  record: SharedTextStructuralHistory,
): { changes: SharedTextChange[]; retained: boolean } => {
  if (record.retained) return { changes: [], retained: true };
  if (record.column) {
    const header = resolve(text, record.column.header),
      hyphen = resolve(text, record.column.hyphen);
    const table = T.findTables(text.toString()).find((table) => table.lines[0]!.to === header);
    const column = table?.lines[1]!.cells.findIndex((cell) => hyphen !== null && hyphen >= cell.from && hyphen < cell.to) ?? -1;
    if (!table || column < 0) return reject();
    const dependent = table.lines.some((line, row) => (row === 1 ? line.cells[column]?.text.includes(":") : !!line.cells[column]?.text));
    if (dependent) return { changes: [], retained: true };
    const changes = T.deleteColumn(table, column);
    if (!changes.length) return reject();
    const owned = record.patches.flatMap((patch) => (patch.added ? [patch.added] : []));
    const source = text.toString();
    for (const change of changes) {
      const row = table.lines.findIndex((line) => change.from >= line.from && change.to <= line.to);
      const line = table.lines[row];
      // Native append has one canonical scaffold, generated by insertRow. Prove
      // its ORIGINAL delimiter IDs, not trimmed cell emptiness. A later space
      // has another clock even if it looks exactly like scaffold padding.
      let appended: Run | undefined;
      if (row >= 2 && line) {
        const newline = table.lines[0]!.lineBreak || "\n";
        const start = Y.createRelativePositionFromTypeIndex(text, line.from - newline.length).item;
        const expected = T.insertRow(table, 0)[0]!.insert;
        const pipeOffsets = [...expected.matchAll(/\|/g)].map((match) => match.index);
        if (
          start &&
          line.pipes.length === pipeOffsets.length &&
          line.pipes.every((at, index) => {
            const id = Y.createRelativePositionFromTypeIndex(text, at).item;
            return id?.client === start.client && id.clock === start.clock + pipeOffsets[index]!;
          }) &&
          source.slice(change.from, change.to) === "   |"
        )
          appended = { client: start.client, clock: start.clock + newline.length + 1 + column * 4, length: 4 };
      }
      const scaffold = appended ? [...owned, appended] : owned;
      if (
        runs(text, change.from, change.to).some(
          (run) =>
            !scaffold.some(
              (allowed) =>
                run.client === allowed.client && run.clock >= allowed.clock && run.clock + run.length <= allowed.clock + allowed.length,
            ),
        )
      )
        return { changes: [], retained: true };
    }
    return { changes, retained: false };
  }
  const source = text.toString();
  if (record.patches.some((patch) => patch.removed)) {
    if (record.tables.length && !record.schemas) return reject();
    // Restoring historical slices into newly accepted rows would assign their
    // cells to different headers. Until identity-aware column restoration is
    // available, that changed target visibly rejects without consuming history.
    const tables = T.findTables(source);
    for (const schema of record.schemas ?? []) {
      const table = tables.find((table) => table.lines[0]!.to === resolve(text, schema.header));
      if (
        !table ||
        table.columns !== schema.hyphens.length ||
        table.lines.length - 2 !== schema.rows.length ||
        schema.hyphens.some(
          (value, index) => resolve(text, value) !== table.lines[1]!.cells[index]!.from + table.lines[1]!.cells[index]!.text.indexOf("-"),
        ) ||
        schema.rows.some((value, index) => resolve(text, value) !== (table.lines[index + 2]!.pipes[0] ?? table.lines[index + 2]!.from))
      )
        return reject();
    }
  }
  const deleted = Y.createDeleteSetFromStructStore(text.doc!.store);
  const changes = record.patches.map((patch) => {
    if (patch.added && !patch.removed) {
      const run = patch.added;
      if (deleted.clients.get(run.client)?.some((range) => range.clock < run.clock + run.length && range.clock + range.len > run.clock))
        return reject();
      const at = (clock: number) =>
        Y.createAbsolutePositionFromRelativePosition(
          new Y.RelativePosition(null, null, Y.createID(run.client, clock), 0),
          text.doc!,
          false,
        );
      const from = at(run.clock),
        last = at(run.clock + run.length - 1);
      if (from?.type !== text || last?.type !== text || source.slice(from.index, last.index + 1) !== patch.inserted) return reject();
      return { from: from.index, to: last.index + 1, insert: "" };
    }
    const left = patch.left === null ? -1 : resolve(text, patch.left);
    const right = patch.right === null ? text.length : resolve(text, patch.right);
    if (left === null || right === null || right <= left || source.slice(left + 1, right) !== patch.inserted) return reject();
    if (patch.added) {
      const run = patch.added;
      if (deleted.clients.get(run.client)?.some((range) => range.clock < run.clock + run.length && range.clock + range.len > run.clock))
        return reject();
      const first = Y.createRelativePositionFromTypeIndex(text, left + 1).item;
      const last = Y.createRelativePositionFromTypeIndex(text, right - 1).item;
      if (
        first?.client !== run.client ||
        first.clock !== run.clock ||
        last?.client !== run.client ||
        last.clock !== run.clock + run.length - 1
      )
        return reject();
    }
    return { from: left + 1, to: right, insert: patch.removed, ...(patch.recreate ? { recreate: true as const } : {}) };
  });
  return { changes, retained: false };
};

/** Ordinary input may also remove row/column syntax (raw Markdown/paste).
 * Only the server classifies that ingress. A changed scaffold fences older
 * unconfirmed input; unchanged cell input remains concurrently mergeable.
 * The identity signature is transient; only the bounded classification enters
 * the existing retained event, never a second snapshot or recovery store.
 */
export const prepareIngressHistory = (text: Y.Text) => {
  const signature = () =>
    JSON.stringify(
      T.findTables(text.toString()).map((table) => ({
        header: anchor(text, table.lines[0]!.to),
        hyphens: table.lines[1]!.cells.map((cell) => anchor(text, cell.from + cell.text.indexOf("-"))),
        rows: table.lines.map((line) => ({
          before: line.from > 0 ? anchor(text, line.from - 1) : null,
          pipes: line.pipes.map((at) => anchor(text, at)),
        })),
      })),
    );
  const before = signature();
  return (): SharedTextStructuralHistory => ({ patches: [], tables: [], ...(signature() !== before ? { ingressBarrier: true } : {}) });
};

/** Stream retained provenance: memory is one document, one update and one receipt. */
export const createStructuralIngressValidation = (doc: Y.Doc, update: Uint8Array) => {
  const currentText = doc.getText("codemirror");
  const decoded = Y.decodeUpdate(update);
  const known = Y.decodeStateVector(Y.encodeStateVector(doc));
  const introduced = decoded.structs.filter(
    (item): item is Y.Item => item instanceof Y.Item && item.id.clock + item.length > (known.get(item.id.client) ?? 0),
  );
  let candidate: Y.Doc | undefined;
  let tables: T.Table[] | undefined;
  return {
    check(record: SharedTextStructuralHistory, inverseSource?: SharedTextStructuralHistory): boolean {
      if (record.ingressBarrier) return false;
      const removed = record.patches.flatMap((patch) => patch.deleted);
      const replaces = record.patches.some((patch) => patch.inserted.length > 0);
      // Restoration provenance lives on the referenced retained receipt. Read
      // it one event at a time: no growing map of all crossed action receipts.
      if (replaces && record.inverseOf && !inverseSource) return false;
      const replaced = inverseSource ? [...removed, ...inverseSource.patches.flatMap((patch) => patch.deleted)] : removed;
      const touchesRemoved = (id: Y.ID | null) =>
        id && removed.some((run) => id.client === run.client && id.clock >= run.clock && id.clock < run.clock + run.length);
      if (introduced.some((item) => touchesRemoved(item.origin) || touchesRemoved(item.rightOrigin))) return false;
      // Deletion-only input has no introduced origins. The receipt removed
      // these IDs while they were LIVE, so an older unconfirmed removal cannot
      // silently count as applied to their recreated replacement. An already
      // accepted deletion is absent from these live removed runs and may retry.
      // Pure removals create no replacement target: a stale row deletion may
      // safely also remove already-deleted empty column scaffold.
      if (
        replaces &&
        replaced.some((run) =>
          decoded.ds.clients.get(run.client)?.some((range) => range.clock < run.clock + run.length && range.clock + range.len > run.clock),
        )
      )
        return false;
      if (!candidate) {
        candidate = new Y.Doc();
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc));
        Y.applyUpdate(candidate, update);
        tables = T.findTables(candidate.getText("codemirror").toString());
      }
      if (candidate.store.pendingStructs || candidate.store.pendingDs) return false;
      const text = candidate.getText("codemirror");
      for (const header of record.tables) {
        const table = tables!.find((table) => table.lines[0]!.to === resolve(text, header));
        if (table?.lines.some((line) => line.cells.length !== table.columns)) return false;
        const before = T.findTables(currentText.toString()).find((table) => table.lines[0]!.to === resolve(currentText, header));
        // An appended row encodes the entire old column schema. Its width
        // cannot prove original column identity after that schema was removed.
        if (before && removed.length)
          for (const item of introduced) {
            if (!(item.content instanceof Y.ContentString) || !item.content.str.includes("\n")) continue;
            for (const id of [item.origin, item.rightOrigin]) {
              if (!id) continue;
              const position = Y.createAbsolutePositionFromRelativePosition(new Y.RelativePosition(null, null, id, 0), doc, false);
              if (position?.type === currentText && position.index >= before.from && position.index <= before.to) return false;
            }
          }
      }
      return true;
    },
    dispose() {
      candidate?.destroy();
    },
  };
};

export const validateStructuralIngress = (doc: Y.Doc, update: Uint8Array, crossed: readonly SharedTextStructuralHistory[]): boolean => {
  const validation = createStructuralIngressValidation(doc, update);
  try {
    return crossed.every((record) => validation.check(record));
  } finally {
    validation.dispose();
  }
};
