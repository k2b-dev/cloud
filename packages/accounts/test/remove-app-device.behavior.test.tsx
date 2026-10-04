import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as navigation from "@k2b/ssr/nav";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const requests: Array<{ param: { id: string; deviceId: string }; resolve: (response: Response) => void }> = [];
const refreshed = mock(() => {});
if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      users: {
        ":id": {
          "app-devices": {
            ":deviceId": {
              $delete: ({ param }: { param: { id: string; deviceId: string } }) =>
                new Promise<Response>((resolve) => requests.push({ param, resolve })),
            },
          },
        },
      },
    },
  }));
}
const flush = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};

describe("removing another person's phone from the mobile app", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  let dom: ReturnType<typeof createDomTestHarness>;
  let prompts: typeof import("@k2b/ui").prompts;
  beforeEach(async () => {
    dom = createDomTestHarness();
    spyOn(navigation, "refreshCurrentPath").mockImplementation(refreshed);
    ({ prompts } = await import("@k2b/ui"));
    cleanup = () => dom.cleanup();
  });
  afterEach(() => {
    cleanup();
    mock.restore();
    requests.length = 0;
    refreshed.mockClear();
  });
  const mount = async () => {
    const { default: RemoveAppDevice } = await import("../src/frontend/users/detail/RemoveAppDevice.island");
    const dispose = render(
      () => createComponent(RemoveAppDevice, { userId: "user-id", deviceId: "device-id", name: "Work phone" }),
      dom.root,
    );
    const previousCleanup = cleanup;
    cleanup = () => {
      dispose();
      previousCleanup();
    };
    return dom.root.querySelector("button")!;
  };

  test("cancelling the confirmation never removes the phone", async () => {
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(false);
    const button = await mount();
    expect(button.getAttribute("aria-label")).toBe("Remove phone Work phone");
    button.click();
    await flush();
    expect(confirm.mock.calls[0]![0]).toContain("Work phone");
    expect(confirm.mock.calls[0]![1]).toMatchObject({ title: "Remove phone", confirmText: "Remove phone", variant: "danger" });
    expect(requests).toHaveLength(0);
  });

  test("a confirmed removal targets the person's phone, shows errors, and refreshes only after success", async () => {
    spyOn(prompts, "confirm").mockResolvedValue(true);
    const error = spyOn(prompts, "error").mockResolvedValue(undefined);
    const button = await mount();
    button.click();
    await flush();
    expect(requests[0]!.param).toEqual({ id: "user-id", deviceId: "device-id" });
    requests[0]!.resolve(new Response("Bad gateway", { status: 502, headers: { "content-type": "text/plain" } }));
    await flush();
    expect(error).toHaveBeenCalledWith("The phone could not be removed.");
    expect(refreshed).not.toHaveBeenCalled();

    button.click();
    await flush();
    // An already removed phone answers `revoked: false`; the page refreshes either way.
    requests[1]!.resolve(Response.json({ revoked: false }));
    await flush();
    expect(refreshed).toHaveBeenCalledTimes(1);
  });
});
