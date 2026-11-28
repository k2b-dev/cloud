import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

let respond: (response: Response) => void;
const post = mock(
  () =>
    new Promise<Response>((resolve) => {
      respond = resolve;
    }),
);
if (!isServer) {
  mock.module("@k2b/cloud/clients/core", () => ({ coreClient: { admin: { lifecycle: { jobs: { $post: post } } } } }));
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("account operations feedback", () => {
  if (isServer) {
    test.skip("requires browser conditions and the DOM preload", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    mock.restore();
    post.mockClear();
  });

  for (const success of [true, false]) {
    test(
      success ? "successful enqueue shows one toast, not a second confirmation" : "failed enqueue never reports success and allows retry",
      async () => {
        const dom = createDomTestHarness();
        const { Dialog } = await import("@k2b/ui/v2");
        const confirm = spyOn(Dialog, "confirm").mockResolvedValue(true);
        const { default: Operations } = await import("../src/pages/admin/signin/AccountOperations");
        const dispose = render(() => createComponent(Operations, { freeIpaEnabled: false }), dom.root);
        cleanup = () => {
          dispose();
          // the toast region v2 adds to the page goes before the harness takes the document away
          for (const toaster of document.body.querySelectorAll(":scope > .k2-ui")) toaster.remove();
          dom.cleanup();
        };
        // the job's row holds its one deed, "Run"
        const row = [...dom.root.querySelectorAll('[data-k2-part="Row"]')].find((element) =>
          element.textContent?.includes("Local full account expiry"),
        )!;
        expect(row).toBeDefined();
        const run = [...row.querySelectorAll("button")].find((button) => button.textContent?.includes("Run"))!;
        expect(run).toBeDefined();
        run.click();
        await flush();
        expect(post).toHaveBeenCalledTimes(1);
        expect(run.disabled).toBe(true);
        run.click();
        expect(post).toHaveBeenCalledTimes(1);
        respond(Response.json(success ? { jobId: "test-job" } : { message: "Job unavailable" }, { status: success ? 200 : 503 }));
        await flush();
        expect(confirm).toHaveBeenCalledTimes(1);
        const toasts = document.body.textContent ?? "";
        // one toast with the outcome: the queued job, or the server's reason and never the success words
        expect(toasts.split("Local full account expiry maintenance queued.").length - 1).toBe(success ? 1 : 0);
        expect(toasts.includes("Job unavailable")).toBe(!success);
        expect(run.disabled).toBe(false);
        expect(dom.root.querySelector('a[href="/admin/observability/logs?source=auth:local-user:backfill"]')).not.toBeNull();
      },
    );
  }
});
