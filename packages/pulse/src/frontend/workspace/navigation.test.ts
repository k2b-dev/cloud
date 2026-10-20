import { expect, test } from "bun:test";
import { createPulseSettingsNavigation } from "./navigation";

test("opening pushes one modal entry, tab changes replace, and closing goes back exactly once", () => {
  const entries = ["/app/pulse/Base01/sql?sql=SELECT+1&params=%7B%22a%22%3A%22b%22%7D"];
  const calls: string[] = [];
  const navigation = createPulseSettingsNavigation({
    currentHref: () => entries.at(-1)!,
    push: (href) => {
      entries.push(href);
      calls.push("push");
    },
    replace: (href) => {
      entries[entries.length - 1] = href;
      calls.push("replace");
    },
    back: () => {
      entries.pop();
      calls.push("back");
    },
  });
  const previous = entries[0]!;
  navigation.open();
  expect(entries.at(-1)).toContain("settings=general");
  navigation.open("usage");
  expect(entries).toHaveLength(2);
  expect(entries.at(-1)).toContain("settings=usage");
  navigation.close();
  expect(entries).toEqual([previous]);
  expect(calls).toEqual(["push", "replace", "back"]);
});
test("closing a direct settings URL stays in the workspace instead of leaving the app", () => {
  let href = "/app/pulse/Base01/sql/Qry001?params=%7B%7D&settings=members";
  let back = false;
  const navigation = createPulseSettingsNavigation({
    currentHref: () => href,
    push: () => {},
    replace: (next) => {
      href = next;
    },
    back: () => {
      back = true;
    },
  });
  navigation.close();
  expect(href).toBe("/app/pulse/Base01/sql/Qry001?params=%7B%7D");
  expect(back).toBe(false);
});

test("Back closes via route subscription and a modal close callback never goes Back twice", () => {
  const entries = ["/app/pulse/Base01/sql/Qry001"];
  let changed = () => {};
  let backs = 0;
  let removed = false;
  const navigation = createPulseSettingsNavigation({
    currentHref: () => entries.at(-1)!,
    push: (href) => {
      entries.push(href);
    },
    replace: () => {},
    back: () => {
      backs++;
      entries.pop();
      changed();
    },
    subscribe: (listener) => {
      changed = listener;
      return () => {
        removed = true;
      };
    },
  });
  let visible: string | undefined;
  const unsubscribe = navigation.subscribe((tab) => {
    visible = tab;
    if (!tab) navigation.close();
  });
  navigation.open("members");
  expect(navigation.tab()).toBe("members");
  entries.pop();
  changed(); // The person pressed Back in the browser.
  expect(visible).toBeUndefined();
  expect(backs).toBe(0);
  unsubscribe();
  expect(removed).toBe(true);
});
