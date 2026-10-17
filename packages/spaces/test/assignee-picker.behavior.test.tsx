import { describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { SpaceAssignableUser, SpaceItemAssignee } from "@/contracts";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";

const person: SpaceAssignableUser = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "user",
  uid: "lena",
  displayName: "Lena Example",
  avatarHash: "rev1",
  description: "lena · direct access",
};
const agent: SpaceAssignableUser = {
  id: "66666666-6666-4666-8666-666666666666",
  kind: "service_account",
  uid: "Release agent",
  displayName: "Release agent",
  avatarHash: null,
  description: "agent · direct access",
};

const assignable = mock(async () => Response.json([person, agent]));
if (!isServer) mock.module("@/api/client", () => ({ apiClient: { [":id"]: { "assignable-users": { $get: assignable } } } }));

const installPopoverApi = (dom: DomTestHarness) => {
  const prototype = dom.window.HTMLElement.prototype as unknown as HTMLElement;
  const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const open = new WeakSet<Element>();
  const patch = (key: PropertyKey, value: unknown) => {
    descriptors.set(key, Object.getOwnPropertyDescriptor(prototype, key));
    Object.defineProperty(prototype, key, { configurable: true, writable: true, value });
  };
  const matches = prototype.matches;
  patch("matches", function (this: Element, selector: string) {
    return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
  });
  patch("showPopover", function (this: HTMLElement) {
    open.add(this);
  });
  patch("hidePopover", function (this: HTMLElement) {
    open.delete(this);
  });
  patch("scrollIntoView", () => {});
  return () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(prototype, key, descriptor);
      else Reflect.deleteProperty(prototype, key);
    }
  };
};

/** Polls through macrotasks until the condition holds, so the debounced search and its response can settle. */
const waitFor = async (condition: () => boolean) => {
  for (let turn = 0; turn < 50 && !condition(); turn++) await Bun.sleep(0);
  expect(condition()).toBe(true);
};

describe("Spaces assignee picker", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("picking a person or a service account adds it with its kind and picture", async () => {
    const dom = createDomTestHarness();
    const restore = installPopoverApi(dom);
    const { default: SpaceAssigneePicker } = await import("../src/frontend/[id]/_components/shared/SpaceAssigneePicker");
    const changes: SpaceItemAssignee[][] = [];
    const dispose = render(
      () => createComponent(SpaceAssigneePicker, { spaceId: "Space1", value: () => [], onChange: (next) => changes.push(next) }),
      dom.root,
    );
    const options = () => Array.from(dom.root.querySelectorAll<HTMLElement>('[role="option"]'));
    const pick = async (name: string) => {
      dom.root.querySelector<HTMLInputElement>('[role="combobox"]')!.click();
      await waitFor(() => options().some((option) => option.textContent?.includes(name)));
      options()
        .find((option) => option.textContent?.includes(name))!
        .click();
    };

    await pick(agent.displayName);
    // The combobox hands back only the option's ID and label; the picker keeps the principal it listed.
    expect(changes.at(-1)).toEqual([{ id: agent.id, kind: "service_account", displayName: agent.displayName, avatarHash: null }]);
    await pick(person.displayName);
    expect(changes.at(-1)).toEqual([{ id: person.id, kind: "user", displayName: person.displayName, avatarHash: "rev1" }]);

    dispose();
    restore();
    dom.cleanup();
  });
});
