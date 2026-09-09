import { describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

type SelectionPayload = {
  userIds?: string[];
  groupIds?: string[];
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const previewRequests: Array<{
  selection: SelectionPayload;
  signal: AbortSignal;
  response: ReturnType<typeof deferred<Response>>;
}> = [];
const draftRequests: SelectionPayload[] = [];

if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      notifications: {
        batches: {
          preview: {
            $post: ({ json }: { json: { selection: SelectionPayload } }, options: { init: { signal: AbortSignal } }) => {
              const response = deferred<Response>();
              previewRequests.push({
                selection: structuredClone(json.selection),
                signal: options.init.signal,
                response,
              });
              return response.promise;
            },
          },
          $post: ({ json }: { json: { selection: SelectionPayload } }) => {
            draftRequests.push(structuredClone(json.selection));
            return Promise.resolve(Response.json({ id: "draft-1" }));
          },
        },
      },
    },
  }));

  mock.module("@k2b/cloud/account/ui", () => ({
    EntitySearch: (props: { includeUsers?: boolean; includeGroups?: boolean; onSelect: (principal: unknown) => void }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `Select test ${props.includeUsers ? "user" : "group"}`;
      button.onclick = () =>
        props.onSelect(
          props.includeUsers
            ? {
                type: "user",
                userId: "user-1",
                uid: "test-user",
                displayName: "Test User",
                avatarHash: null,
                mail: "test@example.com",
                provider: "local",
              }
            : {
                type: "group",
                groupId: "group-1",
                name: "Test Group",
                description: null,
                provider: "local",
              },
        );
      return button;
    },
  }));
}

const flush = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const buttonByText = (document: Document, text: string) => {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((entry) => entry.textContent?.includes(text));
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
};

const inputValue = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("Accounts notification recipient preview", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("guards preview sources, retries errors, and aborts work when its dialog owner closes", async () => {
    previewRequests.length = 0;
    draftRequests.length = 0;
    const dom = createDomTestHarness();
    const { dialogCore } = await import("@k2b/ui");
    const { default: NewNotificationBatch } = await import("../src/frontend/notifications/NewNotificationBatch.island");
    const dispose = render(() => createComponent(NewNotificationBatch, {}), dom.root);

    buttonByText(dom.document, "New notification").click();
    buttonByText(dom.document, "Add user").click();
    buttonByText(dom.document, "Select test user").click();
    await flush();
    expect(previewRequests).toHaveLength(1);
    expect(previewRequests[0]!.selection).toEqual({ userIds: ["user-1"], groupIds: [] });

    buttonByText(dom.document, "Add group").click();
    buttonByText(dom.document, "Select test group").click();
    await flush();
    expect(previewRequests).toHaveLength(2);
    expect(previewRequests[0]!.signal.aborted).toBe(true);

    previewRequests[0]!.response.resolve(
      jsonResponse({ targetCount: 1, deliverableCount: 1, skippedNoEmailCount: 0, recipientHash: "old" }),
    );
    await flush();
    expect(dom.document.body.textContent).not.toContain("1 deliverable of 1");

    previewRequests[1]!.response.resolve(
      jsonResponse({ targetCount: 2, deliverableCount: 2, skippedNoEmailCount: 0, recipientHash: "current" }),
    );
    await flush();
    expect(dom.document.body.textContent).toContain("2 deliverable of 2");

    buttonByText(dom.document, "Refresh preview").click();
    await flush();
    expect(previewRequests).toHaveLength(3);
    previewRequests[2]!.response.resolve(jsonResponse({ message: "Preview unavailable" }, 503));
    await flush();
    expect(dom.document.body.textContent).toContain("Preview unavailable");

    buttonByText(dom.document, "Refresh preview").click();
    await flush();
    expect(previewRequests).toHaveLength(4);
    previewRequests[3]!.response.resolve(
      jsonResponse({ targetCount: 3, deliverableCount: 3, skippedNoEmailCount: 0, recipientHash: "retried" }),
    );
    await flush();
    expect(dom.document.body.textContent).toContain("3 deliverable of 3");

    inputValue(dom.document.querySelector<HTMLInputElement>('input[placeholder="Maintenance window tonight"]')!, "Subject");
    inputValue(dom.document.querySelector<HTMLTextAreaElement>("textarea")!, "Body");
    buttonByText(dom.document, "Create draft").click();
    await flush();
    expect(previewRequests).toHaveLength(5);
    previewRequests[4]!.response.resolve(jsonResponse({ message: "Fresh preview failed" }, 503));
    await flush();
    expect(dom.document.body.textContent).toContain("Fresh preview failed");
    expect(draftRequests).toHaveLength(0);
    buttonByText(dom.document, "Close").click();

    buttonByText(dom.document, "Refresh preview").click();
    await flush();
    expect(previewRequests).toHaveLength(6);
    buttonByText(dom.document, "Cancel").click();
    await flush();
    expect(dialogCore.isOpen()).toBe(false);
    expect(previewRequests[5]!.signal.aborted).toBe(true);
    expect(draftRequests).toHaveLength(0);

    dispose();
    dom.cleanup();
  });
});
