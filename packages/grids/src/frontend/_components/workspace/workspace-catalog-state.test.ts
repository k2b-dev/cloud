import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { gridsService } from "../../../service";
import { loadCatalog } from "./workspace-catalog-state";

// What the base's navigation lists is read once per page: the level the request read already goes to the catalog
// (no second read of the person's grants), and the app runners only for the app page, whose builder offers them.

const emptyCatalog = {
  tables: [],
  tableLevels: {},
  fieldsByTable: {},
  viewsByTable: {},
  formsByTable: {},
  formLevels: {},
  formTables: [],
  sidebarForms: [],
  documentTemplatesByTable: {},
  documentTemplateLevels: {},
  documentTemplateTables: [],
  sidebarDocumentTemplates: [],
};

const spies = () => ({
  catalog: spyOn(gridsService.base, "catalog").mockResolvedValue(emptyCatalog),
  workflows: spyOn(gridsService.workflow, "listForBase").mockResolvedValue([]),
  launchers: spyOn(gridsService.workflow.launcher, "listForBase").mockResolvedValue([]),
  apps: spyOn(gridsService.customApp, "listSummariesByBase").mockResolvedValue([]),
});

let made: ReturnType<typeof spies> | undefined;
afterEach(() => {
  for (const spy of Object.values(made ?? {})) spy.mockRestore();
  made = undefined;
});

const user = { id: "user-1", memberofGroupIds: ["group-1"] };

describe("the catalog of a base's page", () => {
  test("hands the level read already to the catalog and reads no app runners outside the app page", async () => {
    made = spies();
    await loadCatalog("base-1", user, "admin", { customApps: true, launchers: false });
    expect(made.catalog).toHaveBeenCalledWith({ baseId: "base-1", userId: "user-1", userGroups: ["group-1"], level: "admin" });
    expect(made.apps).toHaveBeenCalledTimes(1);
    expect(made.launchers).not.toHaveBeenCalled();
  });

  test("reads the app runners for the app page", async () => {
    made = spies();
    await loadCatalog("base-1", user, "admin", { customApps: true, launchers: true });
    expect(made.launchers).toHaveBeenCalledWith("base-1", true);
  });

  test("reads neither apps nor runners for who does not manage the base", async () => {
    made = spies();
    await loadCatalog("base-1", user, "write", { customApps: false, launchers: true });
    expect(made.apps).not.toHaveBeenCalled();
    expect(made.launchers).not.toHaveBeenCalled();
  });
});
