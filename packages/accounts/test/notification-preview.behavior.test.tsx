import { describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { NewBatchForm } from "../src/frontend/notifications/new-batch";

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
}

const flush = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

// The form of a new batch (`useNewBatchForm`, shown by `NewBatchPane`): the users and groups the lookups choose drive a
// recipient preview that never shows a stale answer, aborts what an audience change or closing made obsolete, and is
// checked again before a draft is created.
describe("Accounts notification recipient preview", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("guards preview sources, retries errors, and aborts work when its form closes", async () => {
    previewRequests.length = 0;
    draftRequests.length = 0;
    const dom = createDomTestHarness();
    const { useNewBatchForm } = await import("../src/frontend/notifications/new-batch");
    let form!: NewBatchForm;
    const dispose = render(
      () =>
        createComponent(() => {
          form = useNewBatchForm();
          return null;
        }, {}),
      dom.root,
    );

    // a user chosen in the lookup
    form.setUserIds(["user-1"]);
    await flush();
    expect(previewRequests).toHaveLength(1);
    expect(previewRequests[0]!.selection).toEqual({ userIds: ["user-1"], groupIds: [] });

    // a group added before the first preview came: the first is aborted and its late answer never shows
    form.setGroupIds(["group-1"]);
    await flush();
    expect(previewRequests).toHaveLength(2);
    expect(previewRequests[0]!.signal.aborted).toBe(true);

    previewRequests[0]!.response.resolve(
      jsonResponse({ targetCount: 1, deliverableCount: 1, skippedNoEmailCount: 0, recipientHash: "old" }),
    );
    await flush();
    expect(form.previewText()).not.toContain("1 deliverable of 1");

    previewRequests[1]!.response.resolve(
      jsonResponse({ targetCount: 2, deliverableCount: 2, skippedNoEmailCount: 0, recipientHash: "current" }),
    );
    await flush();
    expect(form.previewText()).toContain("2 deliverable of 2");

    form.refreshPreview();
    await flush();
    expect(previewRequests).toHaveLength(3);
    previewRequests[2]!.response.resolve(jsonResponse({ message: "Preview unavailable" }, 503));
    await flush();
    expect(form.previewText()).toContain("Preview unavailable");
    expect(form.previewFailed()).toBe(true);

    form.refreshPreview();
    await flush();
    expect(previewRequests).toHaveLength(4);
    previewRequests[3]!.response.resolve(
      jsonResponse({ targetCount: 3, deliverableCount: 3, skippedNoEmailCount: 0, recipientHash: "retried" }),
    );
    await flush();
    expect(form.previewText()).toContain("3 deliverable of 3");

    // "Create draft" without a subject sends nothing: the field says what is missing
    expect(await form.create()).toBeNull();
    expect(form.tried()).toBe(true);
    expect(previewRequests).toHaveLength(4);

    // with the fields filled, "Create draft" checks a fresh preview first; when that fails, no draft is created
    form.setSubject("Subject");
    form.setBody("Body");
    const created = form.create();
    await flush();
    expect(previewRequests).toHaveLength(5);
    previewRequests[4]!.response.resolve(jsonResponse({ message: "Fresh preview failed" }, 503));
    expect(await created).toBeNull();
    expect(form.error()).toBe("Fresh preview failed");
    expect(draftRequests).toHaveLength(0);

    // closing the form aborts the preview that runs
    form.refreshPreview();
    await flush();
    expect(previewRequests).toHaveLength(6);
    dispose();
    await flush();
    expect(previewRequests[5]!.signal.aborted).toBe(true);
    expect(draftRequests).toHaveLength(0);
    dom.cleanup();
  });
});
