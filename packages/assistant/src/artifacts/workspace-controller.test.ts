import { afterEach, expect, mock, test } from "bun:test";
import { createArtifactWorkspace } from "./workspace-controller";
import { type WorkspaceTab, webTab } from "./workspace-state";

const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
  else Reflect.deleteProperty(globalThis, "window");
});

test("the controller refuses unsupported web addresses before opening or saving", async () => {
  const open = mock(() => null);
  const save = mock(async () => ({ conflict: false as const, revision: 1 }));
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      open,
      history: { state: null, replaceState() {} },
      location: { href: "https://cloud.example/app/assistant" },
    },
  });
  const controller = createArtifactWorkspace(undefined, {
    initial: { chatId: "chat", snapshot: { revision: 0, state: { tabs: [], layout: null, front: null } } },
    store: {
      load: async () => {
        throw new Error("unused");
      },
      save,
    },
  });
  for (const url of ["javascript:void(0)", `data:text/plain,${"a".repeat(501)}`, "https://"]) {
    const tab: WorkspaceTab = { kind: "web", key: JSON.stringify(["web", "chat", url]), conversationId: "chat", url, title: "Page" };
    controller.open(tab);
    controller.openInBrowser(url);
  }
  await controller.saved();
  expect(controller.state().tabs).toEqual([]);
  expect(open).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  const url = `https://example.test/${"a".repeat(501)}`;
  controller.open(webTab("chat", url));
  expect(open).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
  expect(controller.state().tabs).toEqual([]);
});
