import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { connectLive } from "../src/lib/live";

export type NotesBrowserClient = {
  text: () => string;
  insert: (value: string) => void;
  status: () => string;
  pending: () => number;
  state: () => number[];
};
declare global {
  interface Window {
    notesClient: NotesBrowserClient;
  }
}

const parameters = new URLSearchParams(location.search);
const doc = new Y.Doc();
doc.clientID = Number(parameters.get("client"));
const awareness = new Awareness(doc);
awareness.setLocalStateField("user", { name: `Guest ${doc.clientID}`, color: "#000000" });
const session = connectLive({ linkId: parameters.get("link") ?? "", doc, awareness, canEdit: parameters.get("role") !== "read" });
window.notesClient = {
  text: () => doc.getText("text").toString(),
  insert: (value) => doc.getText("text").insert(doc.getText("text").length, value),
  status: session.status,
  pending: session.pending,
  state: () => Array.from(Y.encodeStateAsUpdate(doc)),
};
window.addEventListener(
  "pagehide",
  () => {
    session.close();
    awareness.destroy();
    doc.destroy();
  },
  { once: true },
);
