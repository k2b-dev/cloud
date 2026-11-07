/**
 * Browser side of the notes sync protocol (pwas/notes/protocol.ts): y-websocket frames 0–3 plus
 * update(id, bytes) → ack(id) | reject(id, code) and identity(awarenessId). A change counts as saved
 * only after its ack; unconfirmed updates are kept and sent again after a reconnect. The whole note
 * always stays in the local store as well, so a lost socket never loses text.
 */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { createSignal } from "solid-js";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { frame, message, readReply, updateFrame } from "../../protocol";
import { api } from "./api";

export type LiveStatus = "connecting" | "live" | "offline" | "unsaved" | "gone" | "full";
export type RemotePerson = { awarenessId: number; writerId: number | null; name: string; color: string };
export type MergeReport = { remoteChanges: number; writers: number[] };

/** Origin of updates that arrived from the server; they are never sent back. */
export const LIVE_ORIGIN = Symbol("notes-live");

const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const UNCONFIRMED_MS = 2_000;
const NO_RETRY_REASONS = new Set(["blocked", "expired", "deleted", "read_only"]);

const updateId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export function connectLive(options: {
  linkId: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  canEdit: boolean;
  onMerged?: (report: MergeReport) => void;
  onGone?: (reason: "blocked" | "expired" | "deleted" | "not_found") => void;
}) {
  const { doc, awareness } = options;
  const [status, setStatus] = createSignal<LiveStatus>("connecting");
  const [people, setPeople] = createSignal<RemotePerson[]>([]);
  const [pendingCount, setPendingCount] = createSignal(0);
  const pending = new Map<string, Uint8Array>();
  let socket: WebSocket | undefined;
  let identity: number | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  /** Deleted, expired, blocked or read-only: this link will not work again, so nothing reconnects. */
  let terminal = false;
  let synced = false;
  /** Set once this socket sent the server what it was missing; later edits go one by one. */
  let answered = false;
  let wasOffline = false;
  let editedOffline = false;
  /** Remote awareness lives beside the editor's own state; the server's echo of ours is dropped by identity. */
  const remoteStates = new Map<number, { clock: number; state: Record<string, unknown> | null }>();

  const send = (bytes: Uint8Array) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(new Uint8Array(bytes));
  };
  const sendUpdate = (id: string, update: Uint8Array) => send(updateFrame(id, update));
  const sendAwareness = () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    send(
      frame(message.awareness, (encoder) =>
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID])),
      ),
    );
  };
  const refreshPeople = () => {
    const list: RemotePerson[] = [];
    for (const [awarenessId, entry] of remoteStates) {
      const user = entry.state?.user;
      if (!user || typeof user !== "object") continue;
      const name = Reflect.get(user, "name");
      const color = Reflect.get(user, "color");
      const writer = entry.state ? Reflect.get(entry.state, "writerId") : null;
      if (typeof name !== "string" || typeof color !== "string") continue;
      list.push({ awarenessId, writerId: typeof writer === "number" ? writer : null, name, color });
    }
    setPeople(list);
    // Remote cursors render from the editor's awareness: mirror the trusted remote states there.
    const states = awareness.getStates();
    const removed: number[] = [];
    const added: number[] = [];
    for (const id of [...states.keys()])
      if (id !== doc.clientID && !remoteStates.has(id)) {
        states.delete(id);
        removed.push(id);
      }
    for (const [id, entry] of remoteStates)
      if (entry.state) {
        if (!states.has(id)) added.push(id);
        states.set(id, entry.state);
      }
    // Remote cursors redraw from this event; a person who left must be named in `removed`.
    awareness.emit("change", [{ added, updated: [...remoteStates.keys()].filter((id) => !added.includes(id)), removed }, "remote"]);
  };
  const applyRemoteAwareness = (update: Uint8Array) => {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    for (let index = 0; index < count; index++) {
      const id = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      const parsed: unknown = JSON.parse(decoding.readVarString(decoder));
      if (id === identity) continue;
      const previous = remoteStates.get(id);
      if (previous && previous.clock >= clock) continue;
      if (parsed === null) remoteStates.delete(id);
      else if (typeof parsed === "object") remoteStates.set(id, { clock, state: { ...parsed } });
    }
    refreshPeople();
  };

  const onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === LIVE_ORIGIN || !options.canEdit) return;
    if (!answered) {
      // Offline or before the handshake: the reconnect diff carries this change, one frame for all of them.
      editedOffline = true;
      return;
    }
    const id = updateId();
    pending.set(id, update);
    setPendingCount(pending.size);
    sendUpdate(id, update);
    // A change the server has not confirmed after a moment shows as "Verbindet …", not as saved.
    setTimeout(() => {
      if (pending.has(id) && status() === "live") setStatus("connecting");
    }, UNCONFIRMED_MS);
  };
  const onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === "remote") return;
    if ([...added, ...updated, ...removed].includes(doc.clientID)) sendAwareness();
  };

  const handle = (data: Uint8Array) => {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === message.identity) {
      identity = decoding.readVarUint(decoder);
      return;
    }
    if (type === message.sync) {
      const subtype = decoding.readVarUint(decoder);
      if (subtype === syncProtocol.messageYjsSyncStep1) {
        // The server's state vector: answer with everything it is missing, as an acknowledged update.
        const vector = decoding.readVarUint8Array(decoder);
        if (options.canEdit) {
          // Everything the server lacks, unconfirmed updates included, goes as one update. Many offline edits must
          // not turn into a burst of frames that the server's per-socket rate limit would refuse.
          pending.clear();
          const diff = Y.encodeStateAsUpdate(doc, vector);
          if (diff.byteLength > 2) {
            const id = updateId();
            pending.set(id, diff);
            sendUpdate(id, diff);
          }
          setPendingCount(pending.size);
          answered = true;
        }
        return;
      }
      if (subtype === syncProtocol.messageYjsSyncStep2 || subtype === syncProtocol.messageYjsUpdate) {
        const update = decoding.readVarUint8Array(decoder);
        const before = Y.encodeStateVector(doc);
        Y.applyUpdate(doc, update, LIVE_ORIGIN);
        if (subtype === syncProtocol.messageYjsSyncStep2) {
          const firstSync = !synced;
          synced = true;
          setStatus(pending.size > 0 ? "connecting" : "live");
          if (firstSync && wasOffline && (editedOffline || changedSince(before, update))) {
            options.onMerged?.(mergeReport(update, doc.clientID));
            editedOffline = false;
          }
        }
        return;
      }
      return;
    }
    if (type === message.update) {
      decoding.readVarString(decoder);
      Y.applyUpdate(doc, decoding.readVarUint8Array(decoder), LIVE_ORIGIN);
      return;
    }
    if (type === message.awareness) {
      applyRemoteAwareness(decoding.readVarUint8Array(decoder));
      return;
    }
    const reply = type === message.ack || type === message.reject ? readReply(data) : null;
    if (reply?.type === "ack") {
      pending.delete(reply.id);
      setPendingCount(pending.size);
      if (synced && pending.size === 0 && status() !== "unsaved") setStatus("live");
      return;
    }
    if (reply?.type === "reject") {
      if (reply.code === "text_limit" || reply.code === "state_limit") setStatus("full");
      else if (reply.id) setStatus("unsaved");
    }
  };

  const connect = () => {
    if (closed || terminal) return;
    if (!navigator.onLine) {
      setStatus("offline");
      wasOffline = true;
      return;
    }
    synced = false;
    answered = false;
    setStatus((current) => (current === "offline" ? "offline" : "connecting"));
    const ws = new WebSocket(api.socketUrl(options.linkId));
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      ws.send(new Uint8Array(frame(message.sync, (encoder) => syncProtocol.writeSyncStep1(encoder, doc))));
      sendAwareness();
    };
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) handle(new Uint8Array(event.data));
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = undefined;
      answered = false;
      synced = false;
      remoteStates.clear();
      refreshPeople();
      if (closed) return;
      if (NO_RETRY_REASONS.has(event.reason)) {
        terminal = true;
        if (event.reason !== "read_only") {
          setStatus("gone");
          options.onGone?.(event.reason === "blocked" ? "blocked" : event.reason === "expired" ? "expired" : "deleted");
        }
        return;
      }
      wasOffline = true;
      setStatus("offline");
      void checkGone().then((gone) => {
        if (!gone) schedule();
      });
    };
  };
  /** A refused upgrade carries no reason; ask the link itself before retrying forever. */
  const checkGone = async () => {
    try {
      await api.link(options.linkId);
      return false;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "not_found" || code === "gone" || code === "blocked") {
        terminal = true;
        setStatus("gone");
        options.onGone?.(code === "blocked" ? "blocked" : code === "gone" ? "expired" : "not_found");
        return true;
      }
      return false;
    }
  };
  const schedule = () => {
    if (closed || timer) return;
    const delay = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)] ?? 30_000;
    attempt += 1;
    timer = setTimeout(() => {
      timer = undefined;
      connect();
    }, delay);
  };
  const online = () => {
    if (terminal) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    attempt = 0;
    if (!socket) connect();
  };
  const offline = () => {
    wasOffline = true;
    setStatus("offline");
    socket?.close();
  };

  doc.on("update", onDocUpdate);
  awareness.on("update", onAwarenessUpdate);
  window.addEventListener("online", online);
  window.addEventListener("offline", offline);
  connect();

  return {
    status,
    people,
    pending: pendingCount,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      doc.off("update", onDocUpdate);
      awareness.off("update", onAwarenessUpdate);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      socket?.close(1000, "closed");
      socket = undefined;
    },
  };
}

export type LiveSession = ReturnType<typeof connectLive>;

function changedSince(before: Uint8Array, update: Uint8Array) {
  const vector = Y.decodeStateVector(before);
  for (const struct of Y.decodeUpdate(update).structs) if ((vector.get(struct.id.client) ?? 0) <= struct.id.clock) return true;
  return false;
}

function mergeReport(update: Uint8Array, self: number): MergeReport {
  const writers = new Set<number>();
  let remoteChanges = 0;
  for (const struct of Y.decodeUpdate(update).structs) {
    if (struct.id.client === self) continue;
    writers.add(struct.id.client);
    remoteChanges += 1;
  }
  return { remoteChanges, writers: [...writers] };
}
