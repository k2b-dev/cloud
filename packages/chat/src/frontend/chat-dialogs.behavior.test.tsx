import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createComponent, type JSX } from "solid-js";
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
    const { LeaveChatDialog } = await import("./LeaveChatDialog");
    const { default: MemberPicker } = await import("./MemberPicker");
    const { default: ChatInfoPanel } = await import("./ChatInfoPanel");
    return { LocaleProvider, NewChatDialog, AddPeopleDialog, AddPeopleSummary, LeaveChatDialog, MemberPicker, ChatInfoPanel };
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
  const info = (data: Conversation, fake: ChatDialogStore) =>
    createComponent(modules!.ChatInfoPanel, {
      conversation: data,
      viewerId,
      active: true,
      revision: 0,
      store: fake,
      onClose: () => {},
      onAddPeople: () => {},
      onEditDetails: () => {},
      onLeave: () => {},
    });

  for (const locale of ["en", "de"]) {
    const t = chatMessages.resolve([locale]).t;
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
            memberCount: before,
            preview: { joining: 1, memberCount: after, throughGroups: 0 },
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
            memberCount: 30,
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
          store: store({ previewMembers }),
          conversation: { ...conversation, memberCount: 20 },
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
    for (const permission of ["admin", "write", "read"] as const) {
      test(`info offers Add people only to managers: ${permission} in ${locale}`, async () => {
        const onAddPeople = mock<() => void>();
        await mount(locale, () =>
          createComponent(modules!.ChatInfoPanel, {
            conversation: { ...conversation, permission },
            viewerId,
            active: true,
            revision: 0,
            store: store({ members: async () => ({ items: [nora], managers: 1, nextCursor: null }) }),
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
        const members = mock<ChatDialogStore["members"]>(async () => ({ items: [nora], managers, nextCursor: null }));
        const leave = mock<ChatDialogStore["leave"]>(async () => ({ success: true }));
        const close = mock<(left?: boolean) => void>();
        await mount(locale, () =>
          createComponent(modules!.LeaveChatDialog, {
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
    test(`a writer leaves without loading members in ${locale}`, async () => {
      const members = mock<ChatDialogStore["members"]>(unexpected);
      const leave = mock<ChatDialogStore["leave"]>(async () => ({ success: true }));
      await mount(locale, () =>
        createComponent(modules!.LeaveChatDialog, {
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
        if (query.cursor) return { items: [nora], managers: 2, nextCursor: null };
        if (query.q) return pending.promise;
        return { items: [nora], managers: 2, nextCursor: oldCursor };
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
      pending.resolve({ items: [second], managers: 2, nextCursor: newCursor });
      await settle();
      expect(button(t.showMoreMembers).disabled).toBe(false);
      button(t.showMoreMembers).click();
      await settle();
      expect(members.mock.calls[2]).toEqual([conversation.id, { q: "No", cursor: newCursor }]);
      expect([...dom.root.querySelectorAll(".chat-member-row__name")].map((row) => row.textContent)).toEqual(["Noah", "Nora"]);
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
