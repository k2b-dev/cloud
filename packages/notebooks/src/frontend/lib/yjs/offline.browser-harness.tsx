import { EditorView } from "@codemirror/view";
import { listSharedTextOfflineGenerations } from "@k2b/cloud/browser/shared-text";
import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import NoteEditor from "../../[id]/_components/editor/NoteEditor.client";
import type { NotebookDeviceState } from "./offline";
import { notebookDevice } from "./offline.browser-controller";

const view = () => EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor")!);
Object.assign(window, {
  offlineNotebook: {
    ready: () => !!notebookDevice.client,
    connected: () => notebookDevice.connected,
    text: () => view()?.state.doc.toString() ?? "",
    device: () => notebookDevice.state,
    saved: () => listSharedTextOfflineGenerations({ userId: "user-1", draftId: "notebooks:Note01" }),
    reconnect: () => notebookDevice.client?.provider.reconnectNow(),
    flush: () => notebookDevice.client!.flush(),
    discard: () => notebookDevice.client!.discard(),
  },
});
render(
  () => (
    <LocaleProvider locale="en">
      <NoteEditor
        noteId="Note01"
        noteTitle="Saved"
        notebookId="Book01"
        noteLockedAt={null}
        historyIncomplete={false}
        readOnly={new URLSearchParams(location.search).has("readonly")}
        notebookName="Book"
        appUrl={location.origin}
        userId="user-1"
        displayName="Reader"
        canWrite
        initialContent={"Saved\n"}
        initialPanelOpen={false}
        initialRichMode="source"
        initialHref={location.pathname + location.search}
        initialDetail={{
          noteAuthors: { createdBy: null, lastEditedBy: null },
          noteId: "Note01",
          noteTitle: "Saved",
          contentMd: null,
          createdAt: "2020-01-01T00:00:00Z",
          updatedAt: "2020-01-01T00:00:00Z",
          lockedAt: null,
          historyIncomplete: false,
          isLocked: false,
          tocItems: [],
          taskProgress: { total: 0, done: 0 },
          attachments: [],
          backlinks: [],
          namedBlocks: [],
        }}
      />
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);

declare global {
  interface Window {
    offlineNotebook: {
      ready(): boolean;
      connected(): boolean;
      text(): string;
      device(): NotebookDeviceState;
      saved(): Promise<string[]>;
      reconnect(): void;
      flush(): Promise<boolean>;
      discard(): Promise<void>;
    };
  }
}
