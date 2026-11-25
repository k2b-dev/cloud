import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createRenderEffect, createRoot } from "solid-js";
import { isServer } from "solid-js/web";
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

// The delete deed of a user's page (and before it of the duplicate address page): the action behind the button.
describe("account deletion", () => {
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
  /** A button wired like the page's delete entry: it runs the action, and is busy while the action runs. */
  const mount = async (provider: "local" | "ipa" = "local", mail: string | null = user.mail) => {
    const { createDeleteUserAction } = await import("../src/frontend/users/delete-user");
    const button = document.createElement("button");
    dom.root.append(button);
    const dispose = createRoot((dispose) => {
      const action = createDeleteUserAction({ user: { ...user, provider, mail }, onDeleted: () => refreshed() });
      button.addEventListener("click", () => void action.run());
      createRenderEffect(() => {
        button.disabled = action.loading();
      });
      return dispose;
    });
    const previousCleanup = cleanup;
    cleanup = () => {
      dispose();
      previousCleanup();
    };
    return button;
  };

  test("cancel never deletes", async () => {
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(false);
    const button = await mount();
    button.click();
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(0);
  });

  test("an account without email is named without a dangling separator", async () => {
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(false);
    const button = await mount("local", null);
    button.click();
    await flush();
    const content = confirm.mock.calls[0]![0];
    expect(content instanceof HTMLElement && content.querySelector("p")?.textContent).toBe("Ada Lovelace");
  });

  test("FreeIPA confirmation states that both FreeIPA and Cloud are deleted", async () => {
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(false);
    const button = await mount("ipa");
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
    button.click();
    button.click();
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![1]?.title).toContain("guest-ada");
    const content = confirm.mock.calls[0]![0];
    expect(content instanceof HTMLElement && content.querySelector("p")?.textContent).toBe("Ada Lovelace · ada@example.com");
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

  test("a non-JSON error response shows the localized fallback instead of a parse error", async () => {
    spyOn(prompts, "confirm").mockResolvedValue(true);
    const error = spyOn(prompts, "error").mockResolvedValue(undefined);
    const button = await mount();
    button.click();
    await flush();
    requests[0]!.resolve(new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain; charset=UTF-8" } }));
    await flush();
    expect(error).toHaveBeenCalledWith("The user could not be deleted.");
    expect(notice).not.toHaveBeenCalled();
    expect(refreshed).not.toHaveBeenCalled();
  });
});
