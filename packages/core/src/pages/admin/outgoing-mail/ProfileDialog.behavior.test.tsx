import { expect, spyOn, test } from "bun:test";
import type { AdminMailProfile } from "@k2b/cloud/contracts";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { ui: await import("@k2b/ui"), ProfileDialog: (await import("./OutgoingMail.island")).ProfileDialog };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();
const flush = async () => {
  for (let turn = 0; turn < 100; turn++) await Promise.resolve();
};
const profile: AdminMailProfile = {
  key: "noreply",
  name: "No-reply",
  fromAddress: "noreply@example.org",
  fromName: null,
  smtpHost: "smtp.example.org",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: "noreply@example.org",
  hasPassword: true,
  imap: { host: "imap.example.org", port: 993, secure: true, user: "noreply@example.org", folder: "Bounces", hasPassword: true },
  bounces: { checkedAt: "2026-10-08T10:00:00.000Z", error: null },
  pacePerMinute: 60,
  dailyRecipientLimit: null,
  maxAttachmentBytes: 15 * 1024 * 1024,
  isDefault: true,
  revision: 3,
  createdAt: "2026-10-07T10:00:00.000Z",
  updatedAt: "2026-10-07T10:00:00.000Z",
  updatedBy: null,
  appCount: 1,
};

const saveWith = async (change: (dom: ReturnType<typeof createDomTestHarness>) => void) => {
  const dom = createDomTestHarness();
  const { ui, ProfileDialog } = modules!;
  delegateEvents(["input", "click"]);
  const bodies: unknown[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        if (request.method !== "PUT" || !request.url.endsWith("/profiles/noreply")) throw new Error(`Unexpected request: ${request.url}`);
        bodies.push(await request.json());
        return Response.json(profile);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const dispose = render(
    () =>
      createComponent(ui.LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(ProfileDialog, { profile, close: () => {}, onSaved: () => {}, setDismissHandler: () => {} });
        },
      }),
    dom.root,
  );
  try {
    change(dom);
    await flush();
    dom.root.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    await flush();
    return bodies;
  } finally {
    dispose();
    fetch.mockRestore();
    dom.cleanup();
  }
};
const inputByValue = (dom: ReturnType<typeof createDomTestHarness>, value: string) =>
  [...dom.root.querySelectorAll<HTMLInputElement>("input")].find((input) => input.value === value)!;

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("saving another field keeps the IMAP mailbox and its saved password", async () => {
    const bodies = await saveWith((dom) => {
      const name = inputByValue(dom, "No-reply");
      name.value = "System mail";
      name.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
    });
    expect(bodies).toEqual([
      expect.objectContaining({
        name: "System mail",
        imap: { host: "imap.example.org", port: 993, secure: true, user: "noreply@example.org", folder: "Bounces" },
        revision: 3,
      }),
    ]);
  });

  test("an empty IMAP host turns the bounce check off", async () => {
    const bodies = await saveWith((dom) => {
      const host = inputByValue(dom, "imap.example.org");
      host.value = "";
      host.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
    });
    expect(bodies).toEqual([expect.objectContaining({ imap: null })]);
  });
}
