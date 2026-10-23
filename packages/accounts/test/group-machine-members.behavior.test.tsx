import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as navigation from "@k2b/ssr/nav";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const writes: { type: string; id: string; operation: string }[] = [];
const notice = mock(async () => {});
const pending: { resolve?: (response: Response) => void } = {};
if (!isServer) {
  const endpoint =
    (operation: string) =>
    ({ json }: { json: { type: string; id: string } }) => {
      writes.push({ ...json, operation });
      return new Promise<Response>((resolve) => {
        pending.resolve = resolve;
      });
    };
  mock.module("@/api/client", () => ({
    apiClient: { groups: { ":id": { members: { $post: endpoint("add"), $delete: endpoint("remove") } } } },
  }));
  mock.module("../src/frontend/action-notice", () => ({ showAccountActionNotice: notice }));
}
const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
const waitFor = async (condition: () => boolean) => {
  for (let n = 0; n < 100; n++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected DOM state did not arrive");
};
// Load the Solid graph before starting a timed test.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    return {
      ui: await import("@k2b/ui"),
      AddMember: (await import("../src/frontend/groups/detail/AddMember.island")).default,
      MembersTab: (await import("../src/frontend/groups/detail/MembersTab")).default,
    };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

describe("local group machine membership UI", () => {
  if (isServer) {
    test.skip("requires the DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    mock.restore();
    writes.length = 0;
    pending.resolve = undefined;
    notice.mockClear();
  });
  for (const config of [
    { groupProvider: "ipa", membershipRole: "members" },
    { groupProvider: "ipa", membershipRole: "managers" },
  ] as const) {
    test(`${config.groupProvider} ${config.membershipRole}: does not offer machine membership`, async () => {
      const dom = createDomTestHarness();
      const requests: URL[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async (input: string | URL | Request) => {
          requests.push(new URL(input instanceof Request ? input.url : String(input)));
          return Response.json({ items: [] });
        },
        { preconnect: originalFetch.preconnect },
      );
      const dispose = render(() => createComponent(modules!.AddMember, { groupId: "team", ...config }), dom.root);
      cleanup = () => {
        dom.document.querySelector<HTMLButtonElement>(".k2b-dialog__close")?.click();
        dispose();
        globalThis.fetch = originalFetch;
        dom.cleanup();
      };
      dom.root.querySelector<HTMLButtonElement>("button")!.click();
      await flush();
      const input = dom.document.querySelector<HTMLInputElement>("input")!;
      input.value = "Named";
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await waitFor(() => requests.length > 0);
      expect(requests[0]!.searchParams.get("kinds")).toBe("user");
      expect(requests[0]!.searchParams.get("provider")).toBe(config.groupProvider);
      expect(requests[0]!.searchParams.has("service_account_kinds")).toBe(false);
      expect(requests[0]!.searchParams.has("service_account_status")).toBe(false);
    });
  }
  for (const kind of ["standalone", "agent"] as const) {
    test(`${kind}: search keeps the name and kind, submits membership and refreshes after success`, async () => {
      const dom = createDomTestHarness();
      const { AddMember } = modules!;
      const refreshed = spyOn(navigation, "refreshCurrentPath").mockImplementation(() => {});
      const requests: URL[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (input: string | URL | Request) => {
        requests.push(new URL(input instanceof Request ? input.url : String(input)));
        return Response.json({ items: [{ kind: "service_account", serviceAccount: { id: "worker", name: "Named worker", kind } }] });
      });
      const dispose = render(
        () =>
          createComponent(AddMember, {
            groupId: "team",
            groupProvider: "local",
            membershipRole: "members",
            excludeServiceAccountIds: ["existing"],
          }),
        dom.root,
      );
      cleanup = () => {
        dom.document.querySelector<HTMLButtonElement>(".k2b-dialog__close")?.click();
        dispose();
        globalThis.fetch = originalFetch;
        dom.cleanup();
      };
      dom.root.querySelector<HTMLButtonElement>("button")!.click();
      await flush();
      const input = dom.document.querySelector<HTMLInputElement>("input")!;
      expect(input).not.toBeNull();
      input.value = "Named";
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await waitFor(
        () =>
          requests.length > 0 &&
          [...dom.document.querySelectorAll("button")].some((button) => button.textContent?.includes("Named worker")),
      );
      expect(requests[0]!.searchParams.get("kinds")).toContain("service_account");
      expect(requests[0]!.searchParams.get("provider")).toBe("local");
      expect(requests[0]!.searchParams.get("service_account_kinds")).toBe("standalone,agent");
      expect(requests[0]!.searchParams.get("service_account_status")).toBe("active");
      expect(requests[0]!.searchParams.get("exclude_service_account_ids")).toBe("existing");
      const option = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Named worker"),
      )!;
      expect(option.textContent).toContain(kind === "agent" ? "Agent" : "Service account");
      option.click();
      await flush();
      expect(writes).toEqual([{ type: "service_account", id: "worker", operation: "add" }]);
      expect(refreshed).not.toHaveBeenCalled();
      pending.resolve!(Response.json({ message: "Added" }));
      await flush();
      expect(notice).toHaveBeenCalledTimes(1);
      expect(refreshed).toHaveBeenCalledTimes(1);
    });

    test(`${kind}: disabled direct rows remove by ID and expose a failure without claiming success`, async () => {
      const dom = createDomTestHarness();
      const { MembersTab, ui } = modules!;
      spyOn(ui.prompts, "confirm").mockResolvedValue(true);
      const error = spyOn(ui.prompts, "error").mockResolvedValue(undefined);
      const refreshed = spyOn(navigation, "refreshCurrentPath").mockImplementation(() => {});
      const dispose = render(
        () =>
          createComponent(MembersTab, {
            groupId: "team",
            groupProvider: "local",
            items: [
              {
                kind: "service_account",
                serviceAccount: {
                  id: "worker",
                  name: "Named worker",
                  kind,
                  status: "disabled",
                  delegatedUserId: null,
                  appId: null,
                  resourceId: null,
                  resourceType: null,
                  createdBy: null,
                  createdAt: "",
                },
                relation: { direct: true },
              },
            ],
            pagination: { page: 1, per_page: 100, total: 1, total_pages: 1, has_next: false },
            search: "",
            allMemberIds: [],
            allMemberGroupIds: [],
            isAdmin: false,
            canManage: true,
            indirect: false,
            groupHref: (id: string) => id,
            pageBaseUrl: "/groups/team?page=",
            toggleIndirectUrl: "/groups/team?indirect=true",
            serviceAccountsToggleUrl: "/groups/team",
            showServiceAccounts: true,
          }),
        dom.root,
      );
      cleanup = () => {
        dispose();
        dom.cleanup();
      };
      expect(dom.root.textContent).toContain("Named worker");
      expect(dom.root.textContent).toContain(kind === "agent" ? "Agent" : "Standalone");
      const remove = dom.root.querySelector<HTMLButtonElement>('button[aria-label="Remove Named worker"]');
      expect(remove).not.toBeNull();
      remove!.click();
      await flush();
      expect(writes).toEqual([{ type: "service_account", id: "worker", operation: "remove" }]);
      pending.resolve!(Response.json({ message: "Membership change denied" }, { status: 403 }));
      await flush();
      expect(error).toHaveBeenCalledWith("Membership change denied");
      expect(refreshed).not.toHaveBeenCalled();
      expect(dom.root.textContent).toContain("Named worker");
      remove!.click();
      await flush();
      pending.resolve!(Response.json({ message: "Removed" }));
      await flush();
      expect(refreshed).toHaveBeenCalledTimes(1);
    });
  }
});
