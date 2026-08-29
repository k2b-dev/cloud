import { describe, expect, test } from "bun:test";
import { overviewMessages } from "../overview/messages";
import { queryMessages } from "../query/messages";
import { sidebarMessages } from "../sidebar/messages";
import { workspaceMessages } from "./messages";

describe("Grids workspace message catalogs", () => {
  test("keeps English and German surfaces complete", () => {
    for (const catalog of [workspaceMessages, sidebarMessages, overviewMessages, queryMessages]) {
      expect(catalog.check()).toEqual([]);
    }
  });

  test("resolves German SSR and interactive copy", () => {
    expect(workspaceMessages.resolve(["de-CH"]).t.accessDenied).toBe("Zugriff verweigert");
    expect(sidebarMessages.resolve(["de-DE"]).t.newWorkflow).toBe("Neuer Workflow");
    expect(overviewMessages.resolve(["de"]).t.newBase).toBe("Neue Base");
    expect(queryMessages.resolve(["de-AT"]).t.queryResults).toBe("Abfrageergebnisse");
  });
});
