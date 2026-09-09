import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as navigation from "@k2b/ssr/nav";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const requests: Array<{ id: string; resolve: (response: Response) => void }> = [];
const refreshed = mock(() => {});
const notice = mock(async (_input: unknown, _messages: unknown) => {});
if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      users: {
        ":id": {
          $delete: ({ param }: { param: { id: string } }) => new Promise<Response>((resolve) => requests.push({ id: param.id, resolve })),
        },
      },
    },
  }));
  mock.module("../src/frontend/action-notice", () => ({ showAccountActionNotice: notice }));
}
const user = {
  id: "local-id",
  uid: "guest-ada",
  provider: "local" as const,
  profile: "guest" as const,
  givenname: "Ada",
  sn: "Lovelace",
  displayName: "Ada Lovelace",
  mail: "ada@example.com",
};
const flush = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};

describe("duplicate account deletion", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  let dom: ReturnType<typeof createDomTestHarness>;
  let prompts: typeof import("@k2b/ui").prompts;
  let toast: typeof import("@k2b/ui").toast;
  beforeEach(async () => {
    dom = createDomTestHarness();
    spyOn(navigation, "refreshCurrentPath").mockImplementation(refreshed);
    ({ prompts, toast } = await import("@k2b/ui"));
    cleanup = () => dom.cleanup();
  });
  afterEach(() => {
    cleanup();
    mock.restore();
    requests.length = 0;
    refreshed.mockClear();
    notice.mockClear();
  });
  const mount = async (disabled = false, provider: "local" | "ipa" = "local") => {
    const { default: DeleteDuplicateUser } = await import("../src/frontend/duplicate-emails/DeleteDuplicateUser.island");
    const dispose = render(() => createComponent(DeleteDuplicateUser, { user: { ...user, provider }, disabled }), dom.root);
    const previousCleanup = cleanup;
    cleanup = () => {
      dispose();
      previousCleanup();
    };
    return [...dom.root.querySelectorAll("button")].at(-1)!;
  };

  test("cancel and disabled targets never delete", async () => {
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(false);
    const button = await mount();
    button.click();
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(0);
    const disabled = await mount(true);
    expect(disabled.disabled).toBe(true);
    disabled.click();
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test("FreeIPA confirmation states that both FreeIPA and Cloud are deleted", async () => {
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(false);
    const button = await mount(false, "ipa");
    button.click();
    await flush();
    const content = confirm.mock.calls[0]![0];
    expect(content instanceof HTMLElement && content.textContent).toContain("FreeIPA and Cloud");
    expect(requests).toHaveLength(0);
  });

  test("confirms once, preserves errors, retries and refreshes only after successful deletion", async () => {
    let confirmDelete: (value: boolean) => void = () => {};
    const confirm = spyOn(prompts, "confirm").mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          confirmDelete = resolve;
        }),
    );
    const error = spyOn(prompts, "error").mockResolvedValue(undefined);
    spyOn(toast, "success").mockImplementation(() => "test-toast");
    const button = await mount();
    expect(button.getAttribute("aria-label")).toBe("Delete account guest-ada");
    button.click();
    button.click();
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![1]?.title).toContain("guest-ada");
    const content = confirm.mock.calls[0]![0];
    expect(content instanceof HTMLElement && content.textContent).toContain("ada@example.com");
    expect(content instanceof HTMLElement && content.textContent).toContain("not transferred");
    confirmDelete(true);
    await flush();
    expect(button.disabled).toBe(true);
    button.click();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.id).toBe("local-id");
    requests[0]!.resolve(Response.json({ message: "Deletion denied" }, { status: 403 }));
    await flush();
    expect(error).toHaveBeenCalledWith("Deletion denied");
    expect(refreshed).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    button.click();
    await flush();
    confirmDelete(true);
    await flush();
    requests[1]!.resolve(Response.json({ message: "Deleted" }));
    await flush();
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0]?.[0]).toMatchObject({ action: "user.delete", id: "local-id", provider: "local", category: "guest" });
    expect(refreshed).toHaveBeenCalledTimes(1);
  });
});
