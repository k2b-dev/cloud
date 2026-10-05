import { expect, spyOn, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { AssistantLiveProvider, createAssistantLiveHub } from "../frontend/assistant-live";

// Load once outside any test, so the cold Solid transform of the workspace's source graph does not count against the
// 5 s test timeout. The @k2b/ui browser build needs a document while its modules evaluate.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    const { ArtifactWorkspace, createArtifactWorkspace } = await import("./Workspace");
    const { fileTab, sourceTab, workspaceSelectionHref } = await import("./workspace-state");
    return { ArtifactWorkspace, createArtifactWorkspace, fileTab, sourceTab, workspaceSelectionHref };
  } finally {
    dom.cleanup();
  }
};
const { ArtifactWorkspace, createArtifactWorkspace, fileTab, sourceTab, workspaceSelectionHref } = await load();

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

test("a PDF file tab previews the conversation file bytes instead of the attachment download URL", async () => {
  const dom = createDomTestHarness();
  const live = createAssistantLiveHub();
  // A real PDF header carries a binary comment line; bytes above 0x7f must survive the base64 round trip.
  const pdf = new Uint8Array([...new TextEncoder().encode("%PDF-1.7\n%"), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]);
  const requests: string[] = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        requests.push(String(input));
        return new Response(pdf, {
          headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="report.pdf"' },
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const created: Blob[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => {
    created.push(blob as Blob);
    return `blob:assistant-pdf-${created.length}`;
  };
  URL.revokeObjectURL = () => {};
  const controller = createArtifactWorkspace(workspaceSelectionHref("/app/assistant", fileTab("chat01", "/report.pdf")));
  const dispose = render(
    () => (
      <AssistantLiveProvider value={live}>
        <ArtifactWorkspace controller={controller} userId="user123" refreshKey="0" onEditTask={() => {}} />
      </AssistantLiveProvider>
    ),
    dom.root,
  );
  try {
    await tick();
    expect(requests).toEqual(["/api/ai/conversations/chat01/files/content?path=%2Freport.pdf"]);
    expect(dom.root.querySelector("object")).toBeNull();
    expect(dom.root.querySelector('[role="tabpanel"] iframe')?.getAttribute("src")).toBe("blob:assistant-pdf-1");
    // The tab already names the file, so the preview sits in the tab without a second frame.
    expect(dom.root.querySelector('[role="tabpanel"] > .k2b-content-file-view')?.getAttribute("data-variant")).toBe("plain");
    expect(created[0]?.type).toBe("application/pdf");
    expect(new Uint8Array(await created[0]!.arrayBuffer())).toEqual(pdf);
  } finally {
    dispose();
    fetchMock.mockRestore();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    dom.cleanup();
  }
});

// Read-only source text keeps Copy without the preview frame, and code keeps the highlighting of its file type.
for (const [path, content, highlighted] of [
  ["style.css", "body {\n  margin: 0;\n}\n", false],
  ["widget.tsx", "export const Widget = () => <p>Stand</p>;\n", true],
] as const) {
  test(`a read-only ${path} tab keeps its copy action without the preview frame`, async () => {
    const dom = createDomTestHarness();
    const live = createAssistantLiveHub();
    const id = "00000000-0000-4000-8000-000000000001";
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () =>
          Response.json({
            id,
            title: "Example",
            revision: 1,
            permission: "read",
            source: { entry: "main.js", files: [{ path, content }] },
          }),
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const controller = createArtifactWorkspace(workspaceSelectionHref("/app/assistant", sourceTab(id, path)));
    const dispose = render(
      () => (
        <AssistantLiveProvider value={live}>
          <ArtifactWorkspace controller={controller} userId="user123" refreshKey="0" onEditTask={() => {}} />
        </AssistantLiveProvider>
      ),
      dom.root,
    );
    try {
      await tick();
      const view = dom.root.querySelector('[role="tabpanel"] > .k2b-content-file-view');
      expect(view?.getAttribute("data-variant")).toBe("plain");
      expect(view?.textContent).toContain(content.split("\n")[0]!.slice(0, 12));
      expect(view?.querySelector("textarea")).toBeNull();
      expect(view?.querySelector(".k2b-copy-button")).not.toBeNull();
      expect(view?.querySelector(".cd-k") !== null).toBe(highlighted);
    } finally {
      dispose();
      fetchMock.mockRestore();
      dom.cleanup();
    }
  });
}
