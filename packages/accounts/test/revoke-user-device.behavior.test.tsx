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
          devices: {
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

describe("revoking another user's sign-in device", () => {
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
    const { default: RevokeUserDevice } = await import("../src/frontend/users/detail/RevokeUserDevice.island");
    const dispose = render(
      () => createComponent(RevokeUserDevice, { userId: "user-id", deviceId: "device-id", name: "Lost phone" }),
      dom.root,
    );
    const previousCleanup = cleanup;
    cleanup = () => {
      dispose();
      previousCleanup();
    };
    return dom.root.querySelector("button")!;
  };

  test("cancelling the confirmation never revokes", async () => {
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(false);
    const button = await mount();
    expect(button.getAttribute("aria-label")).toBe("Revoke device Lost phone");
    button.click();
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toContain("Lost phone");
    expect(confirm.mock.calls[0]![1]).toMatchObject({ title: "Revoke device", confirmText: "Revoke device", variant: "danger" });
    expect(requests).toHaveLength(0);
    expect(refreshed).not.toHaveBeenCalled();
  });

  test("confirmed revocation targets the user's device, shows errors, and refreshes only after success", async () => {
    spyOn(prompts, "confirm").mockResolvedValue(true);
    const error = spyOn(prompts, "error").mockResolvedValue(undefined);
    const button = await mount();
    button.click();
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.param).toEqual({ id: "user-id", deviceId: "device-id" });
    expect(button.disabled).toBe(true);
    requests[0]!.resolve(Response.json({ message: "Admin access required" }, { status: 403 }));
    await flush();
    expect(error).toHaveBeenCalledWith("Admin access required");
    expect(refreshed).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);

    button.click();
    await flush();
    requests[1]!.resolve(new Response("Bad gateway", { status: 502, headers: { "content-type": "text/plain" } }));
    await flush();
    expect(error).toHaveBeenLastCalledWith("The device could not be revoked.");

    button.click();
    await flush();
    requests[2]!.resolve(Response.json({ message: "Device revoked." }));
    await flush();
    expect(refreshed).toHaveBeenCalledTimes(1);
  });
});
