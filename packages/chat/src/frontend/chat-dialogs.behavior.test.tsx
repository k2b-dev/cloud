import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createComponent, createSignal, type JSX } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import { chatMessages } from "../messages";
import { MemberSchema } from "../service/contracts";
import type { ChatDialogStore, Conversation } from "./chat-dialog";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    const { LocaleProvider } = await import("@k2b/ui");
    const { NewChatDialog } = await import("./NewChatDialog");
    const { AddPeopleDialog, AddPeopleSummary } = await import("./AddPeopleDialog");
    const { ChatDetailsDialog } = await import("./ChatDetailsDialog");
    const { LeaveChatDialog } = await import("./LeaveChatDialog");
    const { default: MemberPicker } = await import("./MemberPicker");
    const { default: ChatInfoPanel } = await import("./ChatInfoPanel");
    const { ChatRequestError } = await import("./chat-store");
    return {
      ChatRequestError,
      LocaleProvider,
      NewChatDialog,
      AddPeopleDialog,
      AddPeopleSummary,
      ChatDetailsDialog,
      LeaveChatDialog,
      MemberPicker,
      ChatInfoPanel,
    };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();
const viewerId = "11111111-1111-4111-8111-111111111111";
const personId = "22222222-2222-4222-8222-222222222222";
const now = "2026-10-12T10:30:00.000Z";
const conversation: Conversation = {
  id: "Chat01",
  name: "Planning",
  title: "Planning",
  icon: null,
  purpose: "Plan together",
  memberCount: 2,
  unread: 0,
  read: null,
  withGuests: false,
  peerDeactivated: false,
  permission: "admin",
  rev: 0,
  createdAt: now,
  lastActivityAt: now,
  lastMessage: null,
};
const nora = MemberSchema.parse({
  accessId: "33333333-3333-4333-8333-333333333333",
  principal: { type: "user", userId: personId },
  displayName: "Nora",
  guest: false,
  deactivated: false,
  groupSize: null,
  permission: "write",
  addedAt: now,
});
const self = { accessId: viewerId, permission: "admin" as const, active: true };
const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected store call");
};
const store = (overrides: Partial<ChatDialogStore> = {}): ChatDialogStore => ({
  create: unexpected,
  updateDetails: unexpected,
  members: unexpected,
  previewMembers: unexpected,
  addMembers: unexpected,
  updateMember: unexpected,
  removeMember: unexpected,
  leave: unexpected,
  people: async () => ({ items: [{ id: personId, displayName: "Nora" }], nextCursor: null }),
  ...overrides,
});
const settle = () => Bun.sleep(30);

describe("chat dialogs and info", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  let dom: DomTestHarness;
  let dispose = () => {};
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    dom = createDomTestHarness();
    delegateEvents(["click", "input", "keydown"], dom.document);
    // happy-dom has no Popover API. Only emulate opening; the real picker,
    // loader, options and selection handlers still run.
    const opened = new WeakSet<HTMLElement>();
    const matches = HTMLElement.prototype.matches;
    Object.defineProperties(HTMLElement.prototype, {
      matches: {
        configurable: true,
        value(this: HTMLElement, selector: string) {
          return selector === ":popover-open" ? opened.has(this) : matches.call(this, selector);
        },
      },
      showPopover: {
        configurable: true,
        value(this: HTMLElement) {
          opened.add(this);
        },
      },
      hidePopover: {
        configurable: true,
        value(this: HTMLElement) {
          opened.delete(this);
        },
      },
      scrollIntoView: { configurable: true, value() {} },
    });
  });
  afterEach(async () => {
    dispose();
    await settle();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  });
  const mount = async (locale: string, children: () => JSX.Element) => {
    dispose = render(
      () =>
        createComponent(modules!.LocaleProvider, {
          locale,
          get children() {
            return children();
          },
        }),
      dom.root,
    );
    await settle();
  };
  const button = (label: string, root: ParentNode = dom.root) => {
    const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) =>
        item.textContent?.trim() === label ||
        item.getAttribute("aria-label") === label ||
        item.querySelector(".k2b-dropdown__copy > span")?.textContent === label,
    );
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };
  const input = (selector: string) => {
    const found = dom.root.querySelector<HTMLInputElement>(selector);
    if (!found) throw new Error(`Missing input: ${selector}`);
    return found;
  };
  const type = (field: HTMLInputElement, value: string) => {
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const chooseNora = async () => {
    type(input('[role="combobox"]'), "Nora");
    await Bun.sleep(180);
    button("Nora", dom.document).click();
    await settle();
  };
  const info = (data: Conversation, fake: ChatDialogStore, revision = () => 0, active = () => true) =>
    createComponent(modules!.ChatInfoPanel, {
      conversation: data,
      viewerId,
      get active() {
        return active();
      },
      get revision() {
        return revision();
      },
      store: fake,
      onClose: () => {},
      onAddPeople: () => {},
      onEditDetails: () => {},
      onLeave: () => {},
    });

  for (const locale of ["en", "de"]) {
    const t = chatMessages.resolve([locale]).t;
    for (const kind of ["new", "add", "details", "leave"] as const) {
      test(`${kind} dialog ignores dismissal while writing and allows it when idle in ${locale}`, async () => {
        const pending = Promise.withResolvers<never>();
        const close = mock<(result?: string | boolean) => void>();
        // The prompt's default dismiss closes; registration must replace it with the busy guard.
        let dismiss: () => void = () => close();
        const setDismissHandler = (handler: () => void) => {
          dismiss = handler;
        };
        const fake = store({
          create: () => pending.promise,
          addMembers: () => pending.promise,
          updateDetails: () => pending.promise,
          leave: () => pending.promise,
          previewMembers: async () => ({ joining: 1, memberCount: 3, throughGroups: 0 }),
        });
        await mount(locale, () => {
          const props = { store: fake, conversation, guest: true, viewerId, locale, close, setDismissHandler };
          if (kind === "new") return createComponent(modules!.NewChatDialog, { ...props, dateConfig: { timeZone: "UTC" } });
          if (kind === "add") return createComponent(modules!.AddPeopleDialog, props);
          if (kind === "details") return createComponent(modules!.ChatDetailsDialog, props);
          return createComponent(modules!.LeaveChatDialog, { ...props, conversation: { ...conversation, permission: "write" } });
        });
        dismiss();
        expect(close.mock.calls).toEqual([[]]);
        close.mockClear();
        if (kind === "add") {
          await chooseNora();
          await Bun.sleep(270);
        }
        if (kind === "details") type(input("input"), "Changed name");
        if (kind === "leave") button(t.leaveChat).click();
        else dom.root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await settle();
        try {
          expect(button(t.cancel).disabled).toBe(true);
          dismiss();
          expect(close).not.toHaveBeenCalled();
        } finally {
          pending.reject(new Error("Write failed"));
          await settle();
        }
        expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain(t.requestFailed);
        dismiss();
        expect(close.mock.calls).toEqual([[]]);
      });
    }
    test(`adding people keeps a failed rename separate and retries only the name in ${locale}`, async () => {
      const addMembers = mock<ChatDialogStore["addMembers"]>(async () => ({ added: 1 }));
      const rename = Promise.withResolvers<never>();
      const updateDetails = mock<ChatDialogStore["updateDetails"]>(async () => {
        if (updateDetails.mock.calls.length === 1) return rename.promise;
        return { ...conversation, name: "New name" };
      });
      const onAdded = mock<() => void>();
      const close = mock<(id?: string) => void>();
      await mount(locale, () =>
        createComponent(modules!.AddPeopleDialog, {
          store: store({
            addMembers,
            updateDetails,
            members: async () => ({ items: [], self, managers: 1, nextCursor: null }),
            previewMembers: async () => ({ joining: 1, memberCount: 3, throughGroups: 0 }),
          }),
          conversation: { ...conversation, name: null },
          guest: true,
          viewerId,
          locale,
          close,
          onAdded,
          setDismissHandler: () => {},
        }),
      );
      await chooseNora();
      await Bun.sleep(270);
      type(input('input:not([role="combobox"])'), "New name");
      expect(button(t.startWithoutHistory).disabled).toBe(false);
      dom.root.querySelector("form")!.requestSubmit();
      await settle();
      try {
        expect(onAdded).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
      } finally {
        rename.reject(new Error("Name unavailable"));
        await settle();
      }
      expect(dom.root.querySelector('[role="alert"]')?.textContent).toBe(t.addedNameFailed);
      expect(dom.root.textContent).not.toContain(t.startWithoutHistory);
      expect(input('[role="combobox"]').disabled).toBe(true);
      expect(button(t.removeName({ name: "Nora" })).disabled).toBe(true);
      expect(button(t.saveName).disabled).toBe(false);
      dom.root.querySelector("form")!.requestSubmit();
      await settle();
      expect(addMembers.mock.calls).toEqual([[conversation.id, [nora.principal]]]);
      expect(updateDetails.mock.calls).toEqual([
        [conversation.id, { name: "New name" }],
        [conversation.id, { name: "New name" }],
      ]);
      expect(onAdded).toHaveBeenCalledTimes(1);
      expect(close.mock.calls).toEqual([[]]);
    });
    for (const action of ["open", "create", "back"] as const) {
      test(`new chat duplicate ${action} preserves order, archive state and choice in ${locale}`, async () => {
        const matches = [
          { id: "Chat02", name: null, title: "Latest", lastActivityAt: now, archived: false },
          { id: "Chat03", name: null, title: "Older", lastActivityAt: "2026-10-11T10:30:00.000Z", archived: true },
        ];
        const create = mock<ChatDialogStore["create"]>(async (data) =>
          data.allowDuplicate ? { outcome: "created", conversation: { ...conversation, id: "Chat04" } } : { outcome: "existing", matches },
        );
        const close = mock<(id?: string) => void>();
        await mount(locale, () =>
          createComponent(modules!.NewChatDialog, {
            setDismissHandler: () => {},
            store: store({ create }),
            guest: true,
            viewerId,
            locale,
            dateConfig: { timeZone: "UTC" },
            close,
          }),
        );
        await chooseNora();
        type(input('input:not([role="combobox"])'), "Chosen name");
        dom.root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await settle();
        expect(create.mock.calls).toEqual([[{ members: [nora.principal], name: "Chosen name" }]]);
        const rows = [...dom.root.querySelectorAll("li")];
        expect(rows).toHaveLength(2);
        expect(rows[0]?.textContent).toContain("Latest");
        expect(rows[1]?.textContent).toContain("Older");
        expect(rows[0]?.textContent).not.toContain(t.archived);
        expect(rows[1]?.textContent).toContain(t.archived);
        expect(button(t.openExisting).getAttribute("data-variant")).toBe("primary");
        if (action === "open") {
          button(t.openExisting).click();
          expect(close.mock.calls).toEqual([["Chat02"]]);
          expect(create).toHaveBeenCalledTimes(1);
        } else if (action === "create") {
          button(t.createAnyway).click();
          await settle();
          expect(create.mock.calls[1]).toEqual([{ members: [nora.principal], name: "Chosen name", allowDuplicate: true }]);
          expect(close.mock.calls).toEqual([["Chat04"]]);
        } else {
          button(t.back).click();
          await settle();
          expect(dom.root.querySelector('[role="combobox"]')).not.toBeNull();
          expect(dom.root.querySelector(`ul[aria-label="${t.chosenPeople}"]`)?.textContent).toContain("Nora");
          expect(input('input:not([role="combobox"])').value).toBe("Chosen name");
          expect(close).not.toHaveBeenCalled();
        }
      });
    }
    for (const [before, after] of [
      [19, 20],
      [20, 21],
    ] as const) {
      test(`addition summary shows the quiet warning only on crossing 20: ${before} → ${after} in ${locale}`, async () => {
        await mount(locale, () =>
          createComponent(modules!.AddPeopleSummary, {
            preview: { joining: after - before, memberCount: after, throughGroups: 0 },
          }),
        );
        expect(dom.root.textContent).toContain(t.joining({ count: 1 }));
        expect(dom.root.textContent?.includes(t.quietChat)).toBe(after === 21);
        expect(dom.root.textContent).not.toContain(t.discoverableSuggestion);
        expect(dom.root.querySelector("button")).toBeNull();
      });
    }
    for (const groups of [20, 21]) {
      test(`addition summary suggests Discoverable by only from 21 people through groups: ${groups} in ${locale}`, async () => {
        await mount(locale, () =>
          createComponent(modules!.AddPeopleSummary, {
            preview: { joining: groups, memberCount: 30 + groups, throughGroups: groups },
          }),
        );
        expect(dom.root.textContent).toContain(t.joining({ count: groups }));
        expect(dom.root.textContent?.includes(t.discoverableSuggestion)).toBe(groups === 21);
        // This chat is already quiet; adding members does not repeat the warning.
        expect(dom.root.textContent).not.toContain(t.quietChat);
        expect(dom.root.querySelector("button")).toBeNull();
      });
    }
    test(`adding a guest-picked person debounces the preview and shows its history summary in ${locale}`, async () => {
      const previewMembers = mock<ChatDialogStore["previewMembers"]>(async () => ({ joining: 1, memberCount: 21, throughGroups: 0 }));
      await mount(locale, () =>
        createComponent(modules!.AddPeopleDialog, {
          setDismissHandler: () => {},
          store: store({ previewMembers }),
          // The cached count is stale (people left meanwhile); the server's preview decides whether the chat turns quiet.
          conversation: { ...conversation, memberCount: 25 },
          guest: true,
          viewerId,
          locale,
          close: () => {},
        }),
      );
      expect(previewMembers).not.toHaveBeenCalled();
      await chooseNora();
      expect(previewMembers).not.toHaveBeenCalled();
      expect(dom.root.textContent).toContain(t.previewLoading);
      await Bun.sleep(270);
      expect(previewMembers.mock.calls).toEqual([[conversation.id, [nora.principal]]]);
      expect(dom.root.textContent).toContain(t.joining({ count: 1 }));
      expect(dom.root.textContent).toContain(t.quietChat);
    });
    test(`a failed preview offers Try again for the same choice in ${locale}`, async () => {
      let failing = true;
      const previewMembers = mock<ChatDialogStore["previewMembers"]>(async () => {
        if (failing) throw new Error("offline");
        return { joining: 1, memberCount: 3, throughGroups: 0 };
      });
      await mount(locale, () =>
        createComponent(modules!.AddPeopleDialog, {
          setDismissHandler: () => {},
          store: store({ previewMembers }),
          conversation,
          guest: true,
          viewerId,
          locale,
          close: () => {},
        }),
      );
      await chooseNora();
      await Bun.sleep(270);
      await settle();
      expect(dom.root.textContent).toContain(t.requestFailed);
      expect(button(t.add).disabled).toBe(true);
      failing = false;
      button(t.retry).click();
      await Bun.sleep(270);
      await settle();
      expect(previewMembers.mock.calls).toEqual([
        [conversation.id, [nora.principal]],
        [conversation.id, [nora.principal]],
      ]);
      expect(dom.root.textContent).toContain(t.joining({ count: 1 }));
      expect(button(t.add).disabled).toBe(false);
    });
    test(`starting without history excludes deactivated people and the viewer in ${locale}`, async () => {
      const former = MemberSchema.parse({
        ...nora,
        accessId: "44444444-4444-4444-8444-444444444444",
        principal: { type: "user", userId: "44444444-4444-4444-8444-444444444444" },
        deactivated: true,
      });
      const existing = MemberSchema.parse({
        ...nora,
        accessId: "55555555-5555-4555-8555-555555555555",
        principal: { type: "user", userId: "55555555-5555-4555-8555-555555555555" },
        displayName: "Kai",
      });
      const viewer = MemberSchema.parse({
        ...nora,
        accessId: viewerId,
        principal: { type: "user", userId: viewerId },
        permission: "admin",
      });
      const create = mock<ChatDialogStore["create"]>(async () => ({ outcome: "created", conversation }));
      await mount(locale, () =>
        createComponent(modules!.AddPeopleDialog, {
          setDismissHandler: () => {},
          store: store({
            create,
            members: async () => ({ items: [viewer, existing, former], self, managers: 1, nextCursor: null }),
            previewMembers: async () => ({ joining: 1, memberCount: 3, throughGroups: 0 }),
          }),
          conversation: { ...conversation, name: null },
          guest: true,
          viewerId,
          locale,
          close: () => {},
        }),
      );
      await chooseNora();
      await Bun.sleep(270);
      expect(button(t.startWithoutHistory).disabled).toBe(false);
      button(t.startWithoutHistory).click();
      await settle();
      expect(create.mock.calls).toEqual([[{ members: [existing.principal, nora.principal], allowDuplicate: true }]]);
    });
    test(`a guest cannot start without history when the current entries include a group in ${locale}`, async () => {
      const group = MemberSchema.parse({
        ...nora,
        principal: { type: "group", groupId: "55555555-5555-4555-8555-555555555555" },
        displayName: "Team",
        groupSize: 2,
      });
      const create = mock<ChatDialogStore["create"]>(unexpected);
      await mount(locale, () =>
        createComponent(modules!.AddPeopleDialog, {
          setDismissHandler: () => {},
          store: store({
            create,
            members: async () => ({ items: [group], self, managers: 1, nextCursor: null }),
            previewMembers: async () => ({ joining: 1, memberCount: 3, throughGroups: 2 }),
          }),
          conversation: { ...conversation, name: null },
          guest: true,
          viewerId,
          locale,
          close: () => {},
        }),
      );
      await chooseNora();
      await Bun.sleep(270);
      expect(button(t.add).disabled).toBe(false);
      expect(dom.root.textContent).not.toContain(t.startWithoutHistory);
      expect(create).not.toHaveBeenCalled();
    });
    for (const dialog of ["add", "new"] as const) {
      test(`Enter in the ${dialog} dialog's guest picker does not submit in ${locale}`, async () => {
        const create = mock<ChatDialogStore["create"]>(async () => ({ outcome: "created", conversation }));
        const addMembers = mock<ChatDialogStore["addMembers"]>(async () => ({ added: 1 }));
        const fake = store({
          create,
          addMembers,
          previewMembers: async () => ({ joining: 1, memberCount: 3, throughGroups: 0 }),
          people: async () => ({
            items: [
              { id: personId, displayName: "Nora" },
              { id: "55555555-5555-4555-8555-555555555555", displayName: "Kai" },
            ],
            nextCursor: null,
          }),
        });
        await mount(locale, () =>
          dialog === "add"
            ? createComponent(modules!.AddPeopleDialog, {
                setDismissHandler: () => {},
                store: fake,
                conversation,
                guest: true,
                viewerId,
                locale,
                close: () => {},
              })
            : createComponent(modules!.NewChatDialog, {
                setDismissHandler: () => {},
                store: fake,
                guest: true,
                viewerId,
                locale,
                dateConfig: { timeZone: "UTC" },
                close: () => {},
              }),
        );
        if (dialog === "add") {
          await chooseNora();
          await Bun.sleep(270);
          expect(button(t.add).disabled).toBe(false);
        }
        const field = input('[role="combobox"]');
        type(field, "Kai");
        await Bun.sleep(180);
        expect(field.getAttribute("aria-expanded")).toBe("true");
        expect(dom.document.querySelector('[role="option"]')).not.toBeNull();
        const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
        field.dispatchEvent(enter);
        // happy-dom does not implicitly submit forms on Enter.
        if (!enter.defaultPrevented) dom.root.querySelector("form")!.requestSubmit();
        await settle();
        expect(addMembers).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(enter.defaultPrevented).toBe(true);
      });
    }
    test(`a manager's failed member read stays in the leave dialog and can be retried in ${locale}`, async () => {
      const members = mock<ChatDialogStore["members"]>(async () => {
        if (members.mock.calls.length === 1) throw new Error("Members unavailable");
        return { items: [nora], self, managers: 2, nextCursor: null };
      });
      await mount(locale, () =>
        createComponent(modules!.LeaveChatDialog, {
          setDismissHandler: () => {},
          store: store({ members }),
          conversation,
          viewerId,
          locale,
          close: () => {},
        }),
      );
      expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain(t.membersFailed);
      expect(button(t.leaveChat).disabled).toBe(true);
      button(t.retry).click();
      await settle();
      expect(members.mock.calls).toEqual([
        [conversation.id, {}],
        [conversation.id, {}],
      ]);
      expect(dom.root.textContent).not.toContain(t.membersFailed);
      expect(button(t.leaveChat).disabled).toBe(false);
    });
    test(`the only direct person cannot leave a chat held through a group in ${locale}`, async () => {
      const viewer = MemberSchema.parse({
        ...nora,
        accessId: viewerId,
        principal: { type: "user", userId: viewerId },
        permission: "admin",
      });
      const group = MemberSchema.parse({
        ...nora,
        principal: { type: "group", groupId: "55555555-5555-4555-8555-555555555555" },
        displayName: "Team",
        groupSize: 2,
      });
      const leave = mock<ChatDialogStore["leave"]>(unexpected);
      await mount(locale, () =>
        createComponent(modules!.LeaveChatDialog, {
          setDismissHandler: () => {},
          store: store({ members: async () => ({ items: [viewer, group], self, managers: 1, nextCursor: null }), leave }),
          conversation,
          viewerId,
          locale,
          close: () => {},
        }),
      );
      expect(dom.root.textContent).toContain(t.cannotLeaveAlone);
      expect(dom.root.textContent).not.toContain(t.chooseSuccessor);
      expect(dom.root.querySelector('[role="combobox"]')).toBeNull();
      expect(button(t.leaveChat).disabled).toBe(true);
      button(t.leaveChat).click();
      expect(leave).not.toHaveBeenCalled();
    });
    for (const permission of ["admin", "write", "read"] as const) {
      test(`info offers Add people only to managers: ${permission} in ${locale}`, async () => {
        const onAddPeople = mock<() => void>();
        await mount(locale, () =>
          createComponent(modules!.ChatInfoPanel, {
            conversation: { ...conversation, permission },
            viewerId,
            active: true,
            revision: 0,
            store: store({ members: async () => ({ items: [nora], self: { ...self, permission }, managers: 1, nextCursor: null }) }),
            onClose: () => {},
            onAddPeople,
            onEditDetails: () => {},
            onLeave: () => {},
          }),
        );
        const additions = [...dom.root.querySelectorAll("button")].filter((item) => item.textContent?.trim() === t.addPeople);
        expect(additions).toHaveLength(permission === "admin" ? 1 : 0);
        if (permission === "admin") {
          button(t.addPeople).click();
          expect(onAddPeople).toHaveBeenCalledTimes(1);
        }
      });
    }
    for (const managers of [1, 2]) {
      test(`leaving with ${managers} managers ${managers === 1 ? "requires a successor" : "needs no successor"} in ${locale}`, async () => {
        const members = mock<ChatDialogStore["members"]>(async () => ({ items: [nora], self, managers, nextCursor: null }));
        const leave = mock<ChatDialogStore["leave"]>(async () => ({ success: true, keptThroughGroup: false }));
        const close = mock<(left?: boolean) => void>();
        await mount(locale, () =>
          createComponent(modules!.LeaveChatDialog, {
            setDismissHandler: () => {},
            store: store({ members, leave }),
            conversation,
            viewerId,
            locale,
            close,
          }),
        );
        expect(members.mock.calls[0]).toEqual([conversation.id, {}]);
        if (managers === 1) {
          expect(button(t.leaveChat).disabled).toBe(true);
          button(t.leaveChat).click();
          expect(leave).not.toHaveBeenCalled();
          expect(dom.root.textContent).toContain(t.chooseSuccessor);
          await chooseNora();
          expect(members.mock.calls.at(-1)).toEqual([conversation.id, { q: "Nora" }]);
          expect(dom.root.textContent).toContain(t.successorChosen({ name: "Nora" }));
        } else expect(dom.root.querySelector('[role="combobox"]')).toBeNull();
        expect(button(t.leaveChat).disabled).toBe(false);
        button(t.leaveChat).click();
        await settle();
        expect(leave.mock.calls).toEqual([[conversation.id, managers === 1 ? nora.accessId : undefined]]);
        expect(close.mock.calls).toEqual([[true]]);
      });
    }
    test(`an effective admin with a direct write entry leaves without a successor in ${locale}`, async () => {
      const members = mock<ChatDialogStore["members"]>(async () => ({
        items: [{ ...nora, permission: "admin" }],
        self: { ...self, permission: "write" },
        managers: 1,
        nextCursor: null,
      }));
      const leave = mock<ChatDialogStore["leave"]>(async () => ({ success: true, keptThroughGroup: false }));
      const close = mock<(left?: boolean) => void>();
      await mount(locale, () =>
        createComponent(modules!.LeaveChatDialog, {
          setDismissHandler: () => {},
          store: store({ members, leave }),
          conversation,
          viewerId,
          locale,
          close,
        }),
      );
      expect(members.mock.calls).toEqual([[conversation.id, {}]]);
      expect(button(t.leaveChat).disabled).toBe(false);
      expect(dom.root.textContent).not.toContain(t.chooseSuccessor);
      expect(dom.root.querySelector('[role="combobox"]')).toBeNull();
      button(t.leaveChat).click();
      await settle();
      expect(leave.mock.calls).toEqual([[conversation.id, undefined]]);
      expect(close.mock.calls).toEqual([[true]]);
    });
    test(`a writer leaves without loading members in ${locale}`, async () => {
      const members = mock<ChatDialogStore["members"]>(unexpected);
      const leave = mock<ChatDialogStore["leave"]>(async () => ({ success: true, keptThroughGroup: false }));
      await mount(locale, () =>
        createComponent(modules!.LeaveChatDialog, {
          setDismissHandler: () => {},
          store: store({ members, leave }),
          conversation: { ...conversation, permission: "write" },
          viewerId,
          locale,
          close: () => {},
        }),
      );
      expect(dom.root.querySelector('[role="combobox"]')).toBeNull();
      expect(button(t.leaveChat).disabled).toBe(false);
      button(t.leaveChat).click();
      await settle();
      expect(leave.mock.calls).toEqual([[conversation.id, undefined]]);
      expect(members).not.toHaveBeenCalled();
    });
    test(`a writer made the last manager while leaving gets the successor choice after the refusal in ${locale}`, async () => {
      const members = mock<ChatDialogStore["members"]>(async () => ({
        items: [nora],
        self: { ...self, permission: "admin" },
        managers: 1,
        nextCursor: null,
      }));
      const leave = mock<ChatDialogStore["leave"]>(async () => {
        throw new modules!.ChatRequestError(t.successorRequired, "CONFLICT", 409);
      });
      await mount(locale, () =>
        createComponent(modules!.LeaveChatDialog, {
          setDismissHandler: () => {},
          store: store({ members, leave }),
          conversation: { ...conversation, permission: "write" },
          viewerId,
          locale,
          close: () => {},
        }),
      );
      expect(members).not.toHaveBeenCalled();
      button(t.leaveChat).click();
      await settle();
      expect(leave.mock.calls).toEqual([[conversation.id, undefined]]);
      expect(members.mock.calls).toEqual([[conversation.id, {}]]);
      expect(dom.root.textContent).toContain(t.successorRequired);
      expect(dom.root.textContent).toContain(t.chooseSuccessor);
      expect(button(t.leaveChat).disabled).toBe(true);
    });
    test(`guest picker uses chat people and person icons without groups or directory fetches in ${locale}`, async () => {
      const fetched: string[] = [];
      globalThis.fetch = Object.assign(
        async (request: RequestInfo | URL) => {
          fetched.push(request instanceof Request ? request.url : String(request));
          throw new Error("Guest must not query the platform directory");
        },
        { preconnect: originalFetch.preconnect },
      );
      const people = mock<ChatDialogStore["people"]>(async () => ({ items: [{ id: personId, displayName: "Nora" }], nextCursor: null }));
      const onChange = mock<Parameters<NonNullable<typeof modules>["MemberPicker"]>[0]["onChange"]>();
      await mount(locale, () => createComponent(modules!.MemberPicker, { guest: true, chosen: [], excluded: [], people, onChange }));
      expect(input('[role="combobox"]').placeholder).toBe(t.addPerson);
      type(input('[role="combobox"]'), "Nora");
      await Bun.sleep(180);
      expect(people.mock.calls[0]?.[0]).toBe("Nora");
      const options = [...dom.document.querySelectorAll('[role="option"]')];
      expect(options.map((option) => option.textContent?.trim())).toEqual(["Nora"]);
      expect(options[0]?.querySelector(".ti-user")).not.toBeNull();
      expect(dom.document.querySelector(".ti-users-group")).toBeNull();
      button("Nora", dom.document).click();
      expect(onChange.mock.calls).toEqual([[[{ principal: nora.principal, displayName: "Nora" }]]]);
      expect(fetched).toEqual([]);
    });
    test(`full-account picker renders the platform user/group search in ${locale}`, async () => {
      const people = mock<ChatDialogStore["people"]>(unexpected);
      await mount(locale, () =>
        createComponent(modules!.MemberPicker, { guest: false, chosen: [], excluded: [], people, onChange: () => {} }),
      );
      expect(input("input").placeholder).toBe(locale === "en" ? "Add user or group…" : "Benutzer oder Gruppe hinzufügen…");
      expect(people).not.toHaveBeenCalled();
    });
    test(`info search debounces q, and Show more sends its cursor and appends in ${locale}`, async () => {
      const second = { ...nora, accessId: "44444444-4444-4444-8444-444444444444", displayName: "Noah" };
      const cursor = JSON.stringify({ name: "nora", id: nora.accessId });
      const members = mock<ChatDialogStore["members"]>(async (_id, query) => ({
        items: query.cursor ? [second] : [nora],
        self,
        managers: 2,
        nextCursor: query.cursor ? null : cursor,
      }));
      await mount(locale, () => info(conversation, store({ members })));
      expect(members.mock.calls).toEqual([[conversation.id, {}]]);
      type(input('input[type="search"]'), " No ");
      await Bun.sleep(100);
      expect(members).toHaveBeenCalledTimes(1);
      await Bun.sleep(180);
      expect(members.mock.calls[1]).toEqual([conversation.id, { q: "No" }]);
      button(t.showMoreMembers).click();
      await settle();
      expect(members.mock.calls[2]).toEqual([conversation.id, { q: "No", cursor }]);
      expect([...dom.root.querySelectorAll(".chat-member-row__name")].map((row) => row.textContent)).toEqual(["Nora", "Noah"]);
      expect(dom.root.textContent).not.toContain(t.showMoreMembers);
    });
    test(`info keeps Show more disabled while a new search loads and then uses its new cursor in ${locale}`, async () => {
      const second = { ...nora, accessId: "44444444-4444-4444-8444-444444444444", displayName: "Noah" };
      const oldCursor = JSON.stringify({ name: "nora", id: nora.accessId });
      const newCursor = JSON.stringify({ name: "noah", id: second.accessId });
      const pending = Promise.withResolvers<Awaited<ReturnType<ChatDialogStore["members"]>>>();
      const members = mock<ChatDialogStore["members"]>(async (_id, query) => {
        if (query.cursor) return { items: [nora], self, managers: 2, nextCursor: null };
        if (query.q) return pending.promise;
        return { items: [nora], self, managers: 2, nextCursor: oldCursor };
      });
      await mount(locale, () => info(conversation, store({ members })));
      type(input('input[type="search"]'), "No");
      await Bun.sleep(280);
      expect(members.mock.calls).toEqual([
        [conversation.id, {}],
        [conversation.id, { q: "No" }],
      ]);
      const more = button(t.showMoreMembers);
      expect(more.disabled).toBe(true);
      more.click();
      await settle();
      expect(members).toHaveBeenCalledTimes(2);
      pending.resolve({ items: [second], self, managers: 2, nextCursor: newCursor });
      await settle();
      expect(button(t.showMoreMembers).disabled).toBe(false);
      button(t.showMoreMembers).click();
      await settle();
      expect(members.mock.calls[2]).toEqual([conversation.id, { q: "No", cursor: newCursor }]);
      expect([...dom.root.querySelectorAll(".chat-member-row__name")].map((row) => row.textContent)).toEqual(["Noah", "Nora"]);
    });
    test(`info disables paging after a new search fails and Retry starts its first page in ${locale}`, async () => {
      let fail = true;
      const members = mock<ChatDialogStore["members"]>(async (_id, query) => {
        if (query.q) {
          if (fail) throw new Error("Search unavailable");
          return { items: [nora], self, managers: 1, nextCursor: null };
        }
        const offset = query.cursor ? 100 : 0;
        return {
          items: Array.from({ length: 100 }, (_, index) => ({ ...nora, accessId: `member-${offset + index}` })),
          self,
          managers: 2,
          nextCursor: query.cursor ? "old-page-3" : "old-page-2",
        };
      });
      await mount(locale, () => info(conversation, store({ members })));
      button(t.showMoreMembers).click();
      await settle();
      expect(dom.root.querySelectorAll(".chat-member-row__name")).toHaveLength(200);
      const more = button(t.showMoreMembers);
      type(input('input[type="search"]'), "Nora");
      await Bun.sleep(280);
      expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain(t.membersFailed);
      expect(button(t.showMoreMembers)).toBe(more);
      expect(more.disabled).toBe(true);
      more.click();
      await settle();
      expect(members.mock.calls).toEqual([
        [conversation.id, {}],
        [conversation.id, { cursor: "old-page-2" }],
        [conversation.id, { q: "Nora" }],
      ]);
      fail = false;
      button(t.retry).click();
      await settle();
      expect(members.mock.calls.at(-1)).toEqual([conversation.id, { q: "Nora" }]);
      expect(members).toHaveBeenCalledTimes(4);
      expect(dom.root.querySelectorAll(".chat-member-row__name")).toHaveLength(1);
      expect(dom.root.querySelector('[role="alert"]')).toBeNull();
    });
    test(`returning to info keeps the pages the reader loaded in ${locale}`, async () => {
      const [active, setActive] = createSignal(true);
      const page = (offset: number): Awaited<ReturnType<ChatDialogStore["members"]>> => ({
        items: Array.from({ length: 100 }, (_, index) => ({
          ...nora,
          accessId: `member-${offset + index}`,
          displayName: `Member ${offset + index}`,
        })),
        self,
        managers: 2,
        nextCursor: offset ? null : "page-2",
      });
      const members = mock<ChatDialogStore["members"]>(async (_id, query) => page(query.cursor ? 100 : 0));
      await mount(locale, () => info(conversation, store({ members }), () => 0, active));
      button(t.showMoreMembers).click();
      await settle();
      expect(dom.root.querySelectorAll(".chat-member-row__name")).toHaveLength(200);
      const before = members.mock.calls.length;
      setActive(false);
      await settle();
      setActive(true);
      await settle();
      expect(members.mock.calls.slice(before)).toEqual([
        [conversation.id, {}],
        [conversation.id, { cursor: "page-2" }],
      ]);
      expect(dom.root.querySelectorAll(".chat-member-row__name")).toHaveLength(200);
    });
    for (const q of ["", "Nora"]) {
      test(`info revision preserves two loaded pages with query "${q}" in ${locale}`, async () => {
        const [revision, setRevision] = createSignal(0);
        const pending = Promise.withResolvers<Awaited<ReturnType<ChatDialogStore["members"]>>>();
        const page = (offset: number, updated: boolean): Awaited<ReturnType<ChatDialogStore["members"]>> => ({
          items: Array.from({ length: 100 }, (_, index) => ({
            ...nora,
            accessId: `member-${offset + index}`,
            permission: offset === 0 && index === 0 ? "admin" : "write",
            displayName: `${updated ? "Updated" : "Original"} ${offset + index}`,
          })),
          self,
          managers: updated && offset ? 1 : 2,
          nextCursor: offset ? "page-3" : "page-2",
        });
        let refreshing = false;
        const members = mock<ChatDialogStore["members"]>(async (_id, query) => {
          if (refreshing && query.cursor) return pending.promise;
          return page(query.cursor ? 100 : 0, refreshing);
        });
        await mount(locale, () => info(conversation, store({ members }), revision));
        if (q) {
          type(input('input[type="search"]'), q);
          await Bun.sleep(280);
        }
        button(t.showMoreMembers).click();
        await settle();
        expect(dom.root.querySelectorAll(".chat-member-row__name")).toHaveLength(200);
        expect(button(t.removeName({ name: "Original 0" })).disabled).toBe(false);
        const before = members.mock.calls.length;
        refreshing = true;
        setRevision(1);
        await settle();
        expect(members.mock.calls.slice(before)).toEqual([
          [conversation.id, q ? { q } : {}],
          [conversation.id, { ...(q ? { q } : {}), cursor: "page-2" }],
        ]);
        // Neither the first refreshed page nor loading guidance replaces the existing rows.
        expect(dom.root.querySelector(".chat-member-row__name")?.textContent).toBe("Original 0");
        expect(dom.root.querySelectorAll(".chat-member-row__name")).toHaveLength(200);
        expect(dom.root.textContent).not.toContain(t.membersLoading);
        expect(button(t.showMoreMembers).disabled).toBe(true);
        pending.resolve(page(100, true));
        await settle();
        expect([...dom.root.querySelectorAll(".chat-member-row__name")].map((row) => row.textContent)).toEqual(
          Array.from({ length: 200 }, (_, index) => `Updated ${index}`),
        );
        expect(button(t.showMoreMembers).disabled).toBe(false);
        expect(button(t.removeName({ name: "Updated 0" })).disabled).toBe(true);
        refreshing = false;
        button(t.showMoreMembers).click();
        await settle();
        expect(members.mock.calls.at(-1)).toEqual([conversation.id, { ...(q ? { q } : {}), cursor: "page-3" }]);
      });
    }
    test(`a newer search wins over an unfinished revision reload in ${locale}`, async () => {
      const [revision, setRevision] = createSignal(0);
      const pending = Promise.withResolvers<Awaited<ReturnType<ChatDialogStore["members"]>>>();
      const members = mock<ChatDialogStore["members"]>(async (_id, query) => {
        if (query.q) return { items: [nora], self, managers: 1, nextCursor: null };
        if (revision() && query.cursor) return pending.promise;
        return {
          items: [{ ...nora, accessId: query.cursor ? "second" : "first", displayName: "Old member" }],
          self,
          managers: 2,
          nextCursor: query.cursor ? null : "page-2",
        };
      });
      await mount(locale, () => info(conversation, store({ members }), revision));
      button(t.showMoreMembers).click();
      await settle();
      setRevision(1);
      await settle();
      expect(members).toHaveBeenCalledTimes(4);
      type(input('input[type="search"]'), "Nora");
      await Bun.sleep(280);
      pending.resolve({ items: [{ ...nora, displayName: "Stale result" }], self, managers: 2, nextCursor: "stale-cursor" });
      await settle();
      expect([...dom.root.querySelectorAll(".chat-member-row__name")].map((row) => row.textContent)).toEqual(["Nora"]);
      expect(dom.root.textContent).not.toContain(t.showMoreMembers);
      expect(members.mock.calls.at(-1)).toEqual([conversation.id, { q: "Nora" }]);
    });
    for (const managers of [1, 2]) {
      test(`info locks the last manager's removal and lower levels only at count ${managers} in ${locale}`, async () => {
        const group = MemberSchema.parse({
          ...nora,
          accessId: "44444444-4444-4444-8444-444444444444",
          principal: { type: "group", groupId: "55555555-5555-4555-8555-555555555555" },
          displayName: "Team",
          permission: "admin",
          groupSize: 2,
        });
        await mount(locale, () =>
          info(
            conversation,
            store({
              members: async () => ({
                items: [{ ...nora, permission: "admin" }, group],
                self,
                managers,
                nextCursor: null,
              }),
            }),
          ),
        );
        const remove = button(t.removeName({ name: "Nora" }));
        expect(remove.disabled).toBe(managers === 1);
        expect(remove.getAttribute("aria-description")).toBe(managers === 1 ? t.lastManager : null);
        expect(button(t.removeName({ name: "Team" })).disabled).toBe(false);
        button(t.permissionFor({ name: "Nora" })).click();
        await settle();
        for (const label of [t.permissionRead, t.permissionWrite]) {
          const option = button(label, dom.document);
          expect(option.disabled).toBe(managers === 1);
          expect(option.getAttribute("aria-disabled")).toBe(managers === 1 ? "true" : null);
          if (managers === 1) expect(option.textContent).toContain(t.lastManager);
        }
        expect(button(t.permissionManage, dom.document).disabled).toBe(false);
      });
    }
  }
});
