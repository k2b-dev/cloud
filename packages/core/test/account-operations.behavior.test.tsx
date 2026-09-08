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
  mock.module("@valentinkolb/cloud/clients/core", () => ({ coreClient: { admin: { lifecycle: { jobs: { $post: post } } } } }));
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
        const { prompts, toast } = await import("@k2b/ui");
        const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
        const error = spyOn(prompts, "error").mockResolvedValue(undefined);
        const notification = spyOn(toast, "success").mockImplementation(() => "test-toast");
        const { default: Operations } = await import("../src/pages/admin/settings/_components/AccountOperations.island");
        const dispose = render(() => createComponent(Operations, { freeIpaEnabled: false }), dom.root);
        cleanup = () => {
          dispose();
          dom.cleanup();
        };
        const run = dom.root.querySelector<HTMLButtonElement>('button[aria-label="Run: Local full account expiry"]')!;
        expect(run).not.toBeNull();
        run.click();
        await flush();
        expect(post).toHaveBeenCalledTimes(1);
        expect(run.disabled).toBe(true);
        run.click();
        expect(post).toHaveBeenCalledTimes(1);
        respond(Response.json(success ? { jobId: "test-job" } : { message: "Job unavailable" }, { status: success ? 200 : 503 }));
        await flush();
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(notification).toHaveBeenCalledTimes(success ? 1 : 0);
        expect(error).toHaveBeenCalledTimes(success ? 0 : 1);
        expect(run.disabled).toBe(false);
        expect(dom.root.querySelector('a[href="/admin/observability/logs?source=auth:local-user:backfill"]')).not.toBeNull();
      },
    );
  }
});
