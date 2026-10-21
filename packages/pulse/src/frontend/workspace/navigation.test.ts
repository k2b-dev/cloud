import { expect, test } from "bun:test";
import { createPulseSettingsNavigation } from "./navigation";
import { buildPulseWorkspaceHref, readWorkspacePathState } from "./routes";
import { readSqlDraftHistory } from "./sql-draft-history";

test("opening pushes one modal entry, tab changes replace, and closing goes back exactly once", () => {
  const entries = ["/app/pulse/Base01/sql?sql=SELECT+1&params=%7B%22a%22%3A%22b%22%7D"];
  const calls: string[] = [];
  const navigation = createPulseSettingsNavigation({
    baseId: "Base01",
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
    baseId: "Base01",
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
    baseId: "Base01",
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

test("Back can restore the modal entry while its dirty or busy guard decides", () => {
  const entries = ["/app/pulse/Base01/sql/Qry001"];
  let position = 0;
  const navigation = createPulseSettingsNavigation({
    baseId: "Base01",
    currentHref: () => entries[position]!,
    push: (href) => {
      entries.splice(++position, entries.length, href);
    },
    replace: (href) => {
      entries[position] = href;
    },
    back: () => {
      position--;
    },
  });
  navigation.open("members");
  position--; // Browser Back already moved to the underlying console.
  navigation.restore();
  expect(navigation.tab()).toBe("members");
  expect(entries).toEqual(["/app/pulse/Base01/sql/Qry001", "/app/pulse/Base01/sql/Qry001?settings=members"]);
  navigation.close(); // Confirming discard closes exactly one modal entry.
  expect(position).toBe(0);
});

test("opening settings moves a near-budget SQL payload into history before extending the URL", () => {
  let href = buildPulseWorkspaceHref({ baseId: "Base01", state: { view: "sql", sql: `SELECT '${"x".repeat(3960)}'` } });
  const original = href;
  let state: unknown = { host: 2 };
  const navigation = createPulseSettingsNavigation({
    baseId: "Base01",
    currentHref: () => href,
    currentState: () => state,
    push: (next, data) => {
      href = next;
      state = data;
    },
    replace: (next, data) => {
      href = next;
      state = data;
    },
    back: () => {},
  });
  expect(href.length).toBe(3999);
  navigation.open("general");
  expect(href.length).toBeLessThanOrEqual(4000);
  expect(readSqlDraftHistory(state, "Base01", href)?.sql).toBe(readWorkspacePathState(original, "Base01").sql);
  expect(state).toMatchObject({ host: 2 });
  navigation.open("retention");
  expect(readSqlDraftHistory(state, "Base01", href)?.sql).toBe(readWorkspacePathState(original, "Base01").sql);
});

test("settings preserves near-budget parameter overrides without replacing saved SQL with an empty draft", () => {
  const params = { host: "%".repeat(1312) + "xx" };
  let href = buildPulseWorkspaceHref({ baseId: "Base01", state: { view: "sql", queryId: "Qry001", params } });
  let state: unknown = { host: 2 };
  const navigation = createPulseSettingsNavigation({
    baseId: "Base01",
    currentHref: () => href,
    currentState: () => state,
    push: (next, data) => {
      href = next;
      state = data;
    },
    replace: (next, data) => {
      href = next;
      state = data;
    },
    back: () => {},
  });
  expect(href.length).toBe(3999);
  navigation.open("general");
  expect(readSqlDraftHistory(state, "Base01", href)).toEqual({ view: "sql", sourceId: "", params });
  navigation.open("usage");
  expect(readSqlDraftHistory(state, "Base01", href)?.params).toEqual(params);
});
