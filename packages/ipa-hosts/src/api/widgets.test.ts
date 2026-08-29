import { describe, expect, test } from "bun:test";
import { ipaHostsWidgetBody } from "./widgets";

describe("IPA Hosts widget localization", () => {
  test("renders German through de-CH without changing numeric values", () => {
    const body = ipaHostsWidgetBody({ hostsTotal: 12, hostsInGroups: 10, hostsUngrouped: 2, hostgroupsTotal: 3 }, "de-CH");
    expect(body.title).toBe("IPA-Hosts");
    expect(body.blocks[0]).toMatchObject({ title: "2 nicht gruppierte Hosts", message: "Von 12 gespiegelten Hosts" });
    expect(body.blocks[1]).toMatchObject({ kind: "pills" });
    if (body.blocks[1]?.kind !== "pills") throw new Error("Expected pills block");
    expect(body.blocks[1].pills.slice(0, 2)).toMatchObject([
      { label: "Gruppen", value: 3 },
      { label: "in Gruppen", value: 10 },
    ]);
  });

  test("keeps the English base and localizes the empty state", () => {
    expect(ipaHostsWidgetBody({ hostsTotal: 1, hostsInGroups: 1, hostsUngrouped: 0, hostgroupsTotal: 1 }, "en").blocks[0]).toMatchObject({
      title: "1 host · all assigned",
      message: "1 hostgroup mirrored from FreeIPA",
    });
    expect(ipaHostsWidgetBody({ hostsTotal: 0, hostsInGroups: 0, hostsUngrouped: 0, hostgroupsTotal: 0 }, "de-CH").blocks[0]).toMatchObject(
      {
        title: "Leerer Spiegel",
      },
    );
  });
});
