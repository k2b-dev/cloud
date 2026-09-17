import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as navigation from "@k2b/ssr/nav";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const requests: Array<{ id: string; resolve: (response: Response) => void }> = [];
const notice = mock(async () => {});
if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      groups: {
        ":id": {
          posix: {
            $put: ({ param }: { param: { id: string } }) => new Promise<Response>((resolve) => requests.push({ id: param.id, resolve })),
          },
        },
      },
    },
  }));
  mock.module("../src/frontend/action-notice", () => ({ showAccountActionNotice: notice }));
}
const flush = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};

describe("group POSIX actions", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  let dom: ReturnType<typeof createDomTestHarness>;
  let prompts: typeof import("@k2b/ui").prompts;
  const refreshed = mock(() => {});
  beforeEach(async () => {
    dom = createDomTestHarness();
    ({ prompts } = await import("@k2b/ui"));
    spyOn(navigation, "refreshCurrentPath").mockImplementation(refreshed);
    cleanup = () => dom.cleanup();
  });
  afterEach(() => {
    cleanup();
    mock.restore();
    requests.length = 0;
    notice.mockClear();
    refreshed.mockClear();
  });
  const mount = async (provider: "local" | "ipa", linuxEnabled: boolean, isPosix = false) => {
    const { default: GroupActions } = await import("../src/frontend/groups/detail/GroupActions.island");
    const dispose = render(
      () =>
        createComponent(GroupActions, {
          id: "group-id",
          name: "staff",
          provider,
          linuxEnabled,
          isPosix,
          description: null,
          listHref: "/app/accounts/groups",
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    dom.document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click();
    await flush();
    return [...dom.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
      item.textContent?.includes("Convert to POSIX"),
    );
  };

  test("disabled local setup explains the unavailable action and does not submit", async () => {
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    const action = await mount("local", false);
    expect(action).toBeDefined();
    expect(action!.getAttribute("aria-disabled")).toBe("true");
    expect(action!.textContent).toContain("Enable local Linux identities");
    action!.click();
    await flush();
    expect(confirm).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  test("an assigned group has no conversion action", async () => {
    expect(await mount("local", false, true)).toBeUndefined();
  });

  for (const provider of ["local", "ipa"] as const) {
    test(`${provider} uses the group endpoint and refreshes only after successful assignment`, async () => {
      spyOn(prompts, "confirm").mockResolvedValue(true);
      const error = spyOn(prompts, "error").mockResolvedValue(undefined);
      const action = await mount(provider, provider === "local");
      action!.click();
      await flush();
      expect(requests).toHaveLength(1);
      expect(requests[0]!.id).toBe("group-id");
      expect(refreshed).not.toHaveBeenCalled();
      requests[0]!.resolve(Response.json({ message: "Reserved range exhausted" }, { status: 409 }));
      await flush();
      expect(error).toHaveBeenCalledWith("Reserved range exhausted");
      expect(notice).not.toHaveBeenCalled();
      dom.document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click();
      await flush();
      [...dom.document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent?.includes("Convert to POSIX"))!
        .click();
      await flush();
      requests[1]!.resolve(Response.json({ message: "Prepared" }));
      await flush();
      expect(refreshed).toHaveBeenCalledTimes(1);
      expect(notice).toHaveBeenCalledTimes(1);
    });
  }
});
