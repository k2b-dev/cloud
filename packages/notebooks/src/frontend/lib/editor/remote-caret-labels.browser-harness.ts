import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { remoteCaretLabels } from "./remote-caret-labels";
import { customDarkInit, customLightInit } from "./theme";

// The note editor's collaboration setup with one other person whose caret sits in the text.
const dark = new URLSearchParams(location.search).get("theme") === "dark";
if (dark) document.documentElement.classList.add("dark");

const doc = new Y.Doc();
const ytext = doc.getText("codemirror");
ytext.insert(0, "Packing list for the trip\nTent, stove, and two sleeping bags\nMaps and a first aid kit");
const awareness = new Awareness(doc);

const remoteDoc = new Y.Doc();
Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(doc));
const remoteText = remoteDoc.getText("codemirror");
const remote = new Awareness(remoteDoc);
remote.setLocalStateField("user", { name: "Ada Lovelace", color: "#7c3aed" });

const moveTo = (index: number) => {
  const at = Y.createRelativePositionFromTypeIndex(remoteText, index);
  remote.setLocalStateField("cursor", { anchor: at, head: at });
  applyAwarenessUpdate(awareness, encodeAwarenessUpdate(remote, [remoteDoc.clientID]), "remote");
};

new EditorView({
  parent: document.getElementById("root")!,
  state: EditorState.create({
    doc: ytext.toString(),
    extensions: [yCollab(ytext, awareness), remoteCaretLabels(ytext, awareness), dark ? customDarkInit() : customLightInit()],
  }),
});
moveTo(30);

Object.assign(window, { harness: { moveTo } });
