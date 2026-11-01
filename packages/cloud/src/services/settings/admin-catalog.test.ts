import { expect, spyOn, test } from "bun:test";
import { readAdminSettingsCatalog } from "./admin-catalog";
import { SETTINGS } from "./defaults";
import * as store from "./store";

test("the administrator catalog returns presence without stored, effective or default secret values", async () => {
  const definition = SETTINGS.find((setting) => setting.kind === "secret")!;
  expect(definition).toBeDefined();
  const read = spyOn(store, "readStates").mockResolvedValue(
    new Map([[definition.key, { stored: "readable", value: "private-catalog-fixture" }]]),
  );
  try {
    const result = await readAdminSettingsCatalog([definition.key]);
    expect(result).toEqual([
      {
        key: definition.key,
        kind: "secret",
        group: definition.group,
        stored: "readable",
        storedValuePresent: true,
        envBacked: !!(definition.envBootstrap || definition.envFallback),
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("private-catalog-fixture");
    read.mockResolvedValue(new Map([[definition.key, { stored: "unreadable", value: null }]]));
    expect(await readAdminSettingsCatalog([definition.key])).toEqual([
      expect.objectContaining({ stored: "unreadable", storedValuePresent: true }),
    ]);
  } finally {
    read.mockRestore();
  }
});
