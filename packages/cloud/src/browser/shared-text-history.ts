import * as T from "@k2b/ui/text-editor/model";
import * as Y from "yjs";
import { captureTextAnchor, resolveTextAnchor } from "../shared-text/anchors";
import { captureTableFocus, resolveTableFocus, type TableFocusWitness } from "../shared-text/table-actions";

export type SharedTextInverseRequest = {
  action: "undo" | "redo";
  receiptCursor: string;
  actionId: string;
  applied: Promise<void>;
  cancel: (reason: unknown) => void;
};
type NativeFrame = Y.UndoManager["undoStack"][number];
type CellBoundary = { focus: TableFocusWitness; left: Uint8Array | null; right: Uint8Array };
type Boundary = { left: Uint8Array | null; right: Uint8Array | null; cell?: CellBoundary };
type TextFrame = {
  kind: "text";
  item: NativeFrame;
  boundaries: Boundary[];
  liveInsertions: NativeFrame["insertions"];
  baseline: Uint8Array | null;
};
type Frame = TextFrame | { kind: "structure"; cursor: string };

// UndoManager deliberately skips effectless native frames. A remote structural
// deletion can make an earlier typing frame effectless; reject it before a
// native call can silently consume the next independent step as well.
const hasUncovered = (wanted: NativeFrame["insertions"], excluded: NativeFrame["insertions"]): boolean => {
  for (const [client, ranges] of wanted.clients) {
    const removed = excluded.clients.get(client) ?? [];
    for (const range of ranges) {
      let clock = range.clock;
      for (const deletion of removed) {
        if (deletion.clock + deletion.len <= clock) continue;
        if (deletion.clock > clock) break;
        clock = Math.max(clock, deletion.clock + deletion.len);
        if (clock >= range.clock + range.len) break;
      }
      if (clock < range.clock + range.len) return true;
    }
  }
  return false;
};

/**
 * The supplied manager owns ordinary input only. Structural receipts are remote
 * and their inverses are authorized by the server. Hosts route every history
 * entry point through this controller, including native editor key bindings.
 */
export const createSharedTextActionHistory = (doc: Y.Doc, history: Y.UndoManager, onChange?: () => void, onRetainedColumn?: () => void) => {
  const undo: Frame[] = [],
    redo: Frame[] = [];
  const remote = {};
  const text = doc.getText("codemirror");
  let deletedBoundaries: Boundary[] = [];
  // One public text observer captures surviving identities, before the native
  // manager emits stack-item-added/updated in afterTransaction. Metadata lives
  // only on reachable frames, and disappears with clear/dispose.
  const observe = (event: Y.YTextEvent) => {
    deletedBoundaries = [];
    let at = 0;
    // Content neighbors may be removed/restored by another native manager.
    // Relax only inside the SAME still-live physical cell scaffold, never for
    // an operation deleting table syntax (including delimiter escapes) or a
    // vanished row/column. Reviving a backslash can escape a still-live pipe.
    // Y.Text's changes.deleted is always empty. Its public transaction delete
    // set is the actual deleted content, before transaction cleanup/GC.
    let contentOnly = true;
    Y.iterateDeletedStructs(event.transaction, event.transaction.deleteSet, (item) => {
      if (!(item instanceof Y.Item)) {
        contentOnly = false;
        return;
      }
      if (item.parent !== text) return;
      const content = item.content;
      if (!(content instanceof Y.ContentString) || ["|", "\\", "\n", "\r"].some((value) => content.str.includes(value)))
        contentOnly = false;
    });
    const tables = contentOnly && event.delta.some((delta) => delta.delete) ? T.findTables(text.toString()) : [];
    const captureCell = (at: number): CellBoundary | undefined => {
      for (const table of tables) {
        const index = table.lines.findIndex((line) => at >= line.from && at <= line.to);
        if (index < 0 || index === 1) continue;
        const line = table.lines[index]!;
        for (let column = 0; column < table.columns; column++) {
          const left = line.leadingPipe ? line.pipes[column] : column === 0 ? line.from - 1 : line.pipes[column - 1];
          const right = (line.leadingPipe ? line.pipes[column + 1] : line.pipes[column]) ?? line.to;
          if (left === undefined || at <= left || at > right || right >= text.length) continue;
          try {
            const row = index === 0 ? 0 : index - 1;
            return {
              focus: captureTableFocus(text, {
                tableFrom: table.from,
                rowFrom: line.from,
                columnFrom: table.lines[0]!.cells[column]!.from,
                row,
                column,
              }),
              left: left < 0 ? null : captureTextAnchor(text, left),
              right: captureTextAnchor(text, right),
            };
          } catch {
            return undefined;
          }
        }
      }
      return undefined;
    };
    for (const delta of event.delta) {
      if (delta.retain) {
        at += delta.retain;
      }
      if (delta.insert) at += typeof delta.insert === "string" ? delta.insert.length : 1;
      if (delta.delete) {
        deletedBoundaries.push({
          left: at > 0 ? captureTextAnchor(text, at - 1) : null,
          right: at < text.length ? captureTextAnchor(text, at) : null,
          cell: captureCell(at),
        });
      }
    }
  };
  text.observe(observe);
  const available = (boundary: Boundary, frame: TextFrame) => {
    const left = boundary.left ? resolveTextAnchor(text, boundary.left) : -1;
    const right = boundary.right ? resolveTextAnchor(text, boundary.right) : text.length;
    const removedHere = (bytes: Uint8Array | null) => {
      const id = bytes && Y.decodeRelativePosition(bytes).item;
      return !!id && Y.isDeleted(frame.item.deletions, id);
    };
    // Later edits merged into this SAME native frame may delete its earlier
    // boundary. Their newer outer boundary still protects the whole reversal.
    if ((left === null && !removedHere(boundary.left)) || (right === null && !removedHere(boundary.right))) {
      const cell = boundary.cell;
      const tables = cell ? T.findTables(text.toString()) : [];
      let target = cell && resolveTableFocus(text, cell.focus);
      if (cell && !target) {
        // Inserting a column on the left adds a delimiter BEFORE the original
        // hyphen; it does not replace that column. Native content history can
        // follow this insertion only while the original hyphen/right edge and
        // strict table/row witnesses survive. Server action witnesses stay fixed.
        const hyphen = resolveTextAnchor(text, cell.focus.column.hyphen);
        const oldLeft = resolveTextAnchor(text, cell.focus.column.left);
        for (const table of tables) {
          const separator = table.lines[1]!;
          const column = separator.cells.findIndex((cell) => hyphen !== null && hyphen >= cell.from && hyphen < cell.to);
          if (column < 0) continue;
          const left = separator.leadingPipe ? separator.pipes[column] : column === 0 ? table.lines[0]!.to : separator.pipes[column - 1];
          if (
            left === undefined ||
            oldLeft === null ||
            oldLeft > left ||
            (oldLeft !== table.lines[0]!.to && !separator.pipes.includes(oldLeft))
          )
            continue;
          target = resolveTableFocus(text, {
            ...cell.focus,
            column: { ...cell.focus.column, left: captureTextAnchor(text, left) },
          });
          if (target) break;
        }
      }
      const tableFrom = target?.tableFrom;
      const table = target && tables.find((table) => table.from === tableFrom);
      const line = table && target && T.gridLine(table, target.row);
      if (!cell || !target || !line) return false;
      const edgeLeft = line.leadingPipe ? line.pipes[target.column] : target.column === 0 ? line.from - 1 : line.pipes[target.column - 1];
      const edgeRight = (line.leadingPipe ? line.pipes[target.column + 1] : line.pipes[target.column]) ?? line.to;
      const oldLeft = cell.left ? resolveTextAnchor(text, cell.left) : -1;
      if (
        edgeLeft === undefined ||
        oldLeft === null ||
        oldLeft < line.from - 1 ||
        oldLeft > edgeLeft ||
        (oldLeft !== line.from - 1 && !line.pipes.includes(oldLeft)) ||
        resolveTextAnchor(text, cell.right) !== edgeRight
      )
        return false;
      // A deleted neighbor's ordinary fallback must still lie INSIDE that
      // original column and row. Merely finding a same-looking cell is unsafe.
      return [boundary.left, boundary.right].every((bytes) => {
        if (!bytes) return false;
        const position = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(bytes), doc, false);
        return position?.type === text && position.index > edgeLeft && position.index <= edgeRight;
      });
    }
    if (left !== null && right !== null && right <= left) return false;
    if (boundary.left !== null || boundary.right !== null || !text.length) return true;
    // Whole-text replacements have no external boundaries. They are safe only
    // while all live replacement identities still belong to this frame.
    const first = Y.createRelativePositionFromTypeIndex(text, 0).item;
    if (!first) return false;
    let item: Y.Item | null = Y.getItem(doc.store, first);
    while (item) {
      if (
        !item.deleted &&
        item.countable &&
        !frame.liveInsertions.clients
          .get(item.id.client)
          ?.some((run) => run.clock <= item!.id.clock && run.clock + run.len >= item!.id.clock + item!.length)
      )
        return false;
      item = item.right;
    }
    return true;
  };
  const includesRun = (set: NativeFrame["insertions"], id: Y.ID, length = 1) =>
    set.clients.get(id.client)?.some((run) => run.clock <= id.clock && run.clock + run.len >= id.clock + length) ?? false;
  const restoredAt = (id: Y.ID, created: NativeFrame["insertions"]) => {
    const at = (assoc: number) => Y.createAbsolutePositionFromRelativePosition(new Y.RelativePosition(null, null, id, assoc), doc, true);
    const start = at(0),
      end = at(-1);
    // A deleted item's ordinary fallback resolves both associations to the same
    // gap. A real live native restoration resolves on either SIDE of its char.
    if (start?.type !== text || end?.type !== text || end.index !== start.index + 1) return null;
    const live = Y.createRelativePositionFromTypeIndex(text, start.index).item;
    return live && includesRun(created, live) ? { id: live, index: start.index } : null;
  };
  const refreshRestorations = (created: NativeFrame["insertions"]) => {
    if (!created.clients.size) return;
    for (const frame of [...undo, ...redo]) {
      if (frame.kind !== "text") continue;
      for (const boundary of frame.boundaries)
        for (const side of ["left", "right"] as const) {
          const bytes = boundary[side];
          if (!bytes || resolveTextAnchor(text, bytes) !== null) continue;
          const id = Y.decodeRelativePosition(bytes).item;
          const restored = id && restoredAt(id, created);
          if (restored) boundary[side] = captureTextAnchor(text, restored.index);
        }
      const next = Y.createDeleteSet();
      for (const [client, ranges] of frame.liveInsertions.clients) {
        for (const range of ranges) {
          let clock = range.clock;
          const until = clock + range.len;
          while (clock < until) {
            const item = Y.getItem(doc.store, Y.createID(client, clock));
            const length = Math.min(until - clock, item.id.clock + item.length - clock);
            const first = restoredAt(Y.createID(client, clock), created);
            const last = restoredAt(Y.createID(client, clock + length - 1), created);
            const mapped =
              first &&
              last &&
              first.id.client === last.id.client &&
              last.id.clock === first.id.clock + length - 1 &&
              includesRun(created, first.id, length);
            const id = mapped ? first.id : Y.createID(client, clock);
            const target = next.clients.get(id.client) ?? [];
            target.push({ clock: id.clock, len: length });
            next.clients.set(id.client, target);
            clock += length;
          }
        }
      }
      frame.liveInsertions = Y.mergeDeleteSets([next]);
    }
  };
  let disposed = false;
  let notifying = false;
  // Native events can run inside yCollab's EditorView.update. Host callbacks
  // may reconfigure that view through reactive UI state; never call them there.
  const notify = () => {
    if (notifying || disposed) return;
    notifying = true;
    queueMicrotask(() => {
      notifying = false;
      if (!disposed) onChange?.();
    });
  };
  let moving = false;
  let inverse: ((request: SharedTextInverseRequest) => Promise<void>) | undefined;
  let pending: { id: string; resolve(): void; reject(reason: unknown): void; direction?: "undo" | "redo"; frame?: Frame } | null = null;
  const added = ({ stackItem }: { stackItem: NativeFrame }) => {
    if (moving) return;
    undo.push({
      kind: "text",
      item: stackItem,
      boundaries: [...deletedBoundaries],
      liveInsertions: stackItem.insertions,
      baseline: Y.encodeStateVector(doc),
    });
    redo.length = 0;
    notify();
  };
  const updated = ({ stackItem }: { stackItem: NativeFrame }) => {
    if (moving) return;
    const frame = undo.findLast((frame) => frame.kind === "text" && frame.item === stackItem);
    if (frame?.kind === "text") {
      frame.boundaries.push(...deletedBoundaries);
      frame.liveInsertions = stackItem.insertions;
    }
  };
  const cleared = ({ undoStackCleared, redoStackCleared }: { undoStackCleared: boolean; redoStackCleared: boolean }) => {
    if (moving) return;
    if (undoStackCleared) undo.length = 0;
    if (redoStackCleared) redo.length = 0;
    notify();
  };
  history.on("stack-item-added", added);
  history.on("stack-item-updated", updated);
  history.on("stack-cleared", cleared);
  // Existing input frames have no captured deletion context. Such restoration
  // is unavailable. Insertion-only Undo requires no pre-registration redone
  // chains; validation refuses unknown live correspondence before mutation.
  undo.push(
    ...history.undoStack.map((item) => ({ kind: "text" as const, item, boundaries: [], liveInsertions: item.insertions, baseline: null })),
  );
  const cancel = (id: string, reason: unknown) => {
    if (pending?.id !== id) return;
    const action = pending;
    pending = null;
    action.reject(reason);
    notify();
  };
  const begin = (id: string, direction?: "undo" | "redo", frame?: Frame) => {
    if (disposed || pending || !id) throw new Error("A table action is unavailable or still awaiting its receipt");
    const applied = new Promise<void>((resolve, reject) => {
      pending = { id, resolve, reject, direction, frame };
    });
    void applied.catch(() => {});
    notify();
    return { applied, cancel: (reason: unknown) => cancel(id, reason) };
  };
  const move = async (direction: "undo" | "redo") => {
    if (disposed || pending) return null;
    const from = direction === "undo" ? undo : redo,
      to = direction === "undo" ? redo : undo;
    const frame = from.at(-1);
    if (!frame) return null;
    history.stopCapturing();
    if (frame.kind === "structure") {
      if (!inverse) throw new Error("Structural history requires an authorized inverse handler");
      const actionId = crypto.randomUUID();
      const action = begin(actionId, direction, frame);
      try {
        await inverse({ action: direction, receiptCursor: frame.cursor, actionId, ...action });
        await action.applied;
      } catch (error) {
        action.cancel(error);
        throw error;
      }
      return frame;
    }
    const { validateNativeHistory } = await import("./shared-text-history-validation");
    if (disposed || pending || from.at(-1) !== frame) throw new Error("The input history frame is unavailable");
    // Public UndoManager events preserve CodeMirror selection metadata. Never
    // pop another input frame if the referenced native step became unavailable.
    const stack = direction === "undo" ? history.undoStack : history.redoStack;
    if (stack.at(-1) !== frame.item) throw new Error("The input history frame is unavailable");
    if (
      hasUncovered(frame.item.deletions, frame.item.insertions) &&
      (!frame.boundaries.length || frame.boundaries.some((boundary) => !available(boundary, frame)))
    )
      throw new Error("The input history target is unavailable");
    if (
      !hasUncovered(frame.liveInsertions, Y.createDeleteSetFromStructStore(doc.store)) &&
      !hasUncovered(frame.item.deletions, frame.item.insertions)
    )
      throw new Error("The input history frame is unavailable");
    validateNativeHistory(text, frame.item, frame.liveInsertions, frame.baseline);
    moving = true;
    try {
      const result = direction === "undo" ? history.undo() : history.redo();
      if (!result) throw new Error("The input history frame could not be reversed");
      from.pop();
      const replacement = (direction === "undo" ? history.redoStack : history.undoStack).at(-1);
      if (replacement) {
        to.push({
          kind: "text",
          item: replacement,
          boundaries: [...deletedBoundaries],
          liveInsertions: replacement.insertions,
          baseline: frame.baseline,
        });
        refreshRestorations(replacement.insertions);
      }
      notify();
      return frame;
    } finally {
      moving = false;
    }
  };
  return {
    isRemoteOrigin: (value: unknown) => value === remote,
    hasPending: () => pending !== null,
    canUndo: () => !pending && undo.length > 0,
    canRedo: () => !pending && redo.length > 0,
    nextStructural: (direction: "undo" | "redo") => (direction === "undo" ? undo : redo).at(-1)?.kind === "structure",
    undoDepth: () => undo.length,
    redoDepth: () => redo.length,
    undo: () => move("undo"),
    redo: () => move("redo"),
    setInverseHandler(handler: (request: SharedTextInverseRequest) => Promise<void>) {
      inverse = handler;
    },
    begin(id: string) {
      return begin(id);
    },
    apply(update: Uint8Array, actionId?: string, cursor?: string, retained = false) {
      Y.decodeUpdate(update);
      const action = pending?.id === actionId ? pending : null;
      if (action && !cursor) throw new Error("A structural receipt requires its retained cursor");
      // Probe causal coverage before mutating, so a receipt never resolves
      // while its target predecessors are still missing from this browser.
      if (action) {
        const probe = new Y.Doc();
        try {
          Y.applyUpdate(probe, Y.encodeStateAsUpdate(doc));
          Y.applyUpdate(probe, update);
          if (probe.store.pendingStructs || probe.store.pendingDs) throw new Error("The table action is missing preceding updates");
        } finally {
          probe.destroy();
        }
      }
      history.stopCapturing();
      Y.applyUpdate(doc, update, remote);
      history.stopCapturing();
      if (!action) return;
      pending = null;
      if (action.direction) {
        const from = action.direction === "undo" ? undo : redo,
          to = action.direction === "undo" ? redo : undo;
        const index = from.indexOf(action.frame!);
        if (index >= 0) from.splice(index, 1);
        to.push({ kind: "structure", cursor: cursor! });
        if (retained && action.direction === "undo") onRetainedColumn?.();
      } else {
        undo.push({ kind: "structure", cursor: cursor! });
        redo.length = 0;
        // New structural input invalidates native Redo too. Public clear keeps
        // current typing Undo and releases its unreachable native metadata.
        moving = true;
        try {
          history.clear(false, true);
        } finally {
          moving = false;
        }
      }
      action.resolve();
      notify();
    },
    cancelPending(reason: unknown) {
      if (pending) cancel(pending.id, reason);
    },
    clear() {
      if (pending) cancel(pending.id, new Error("The editor history was cleared"));
      undo.length = redo.length = 0;
      deletedBoundaries = [];
      history.clear();
      notify();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (pending) cancel(pending.id, new Error("The editor closed before the table action was confirmed"));
      text.unobserve(observe);
      deletedBoundaries = [];
      history.off("stack-item-added", added);
      history.off("stack-item-updated", updated);
      history.off("stack-cleared", cleared);
      undo.length = redo.length = 0;
    },
  };
};
