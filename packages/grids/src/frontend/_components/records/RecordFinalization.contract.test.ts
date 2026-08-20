import { describe, expect, test } from "bun:test";

describe("record finalization UI contract", () => {
  test("keeps readiness, confirmation, and immutable state on the record detail surface", async () => {
    const source = await Bun.file(new URL("./RecordDetailPanel.tsx", import.meta.url)).text();

    expect(source).toContain(".finalization.$get");
    expect(source).toContain(".finalize.$post");
    expect(source).toContain(".finalization.request.$post");
    expect(source).toContain(".finalization.approve.$post");
    expect(source).toContain(".finalization.reject.$post");
    expect(source).toContain("json: { requestId, comment }");
    expect(source).toContain("Finalization status unavailable");
    expect(source).toContain("finalizationQueryEnabled() && finalizationQuery.error()");
    expect(source).toContain("Refresh Finalization");
    expect(source).toContain("enabled: finalizationQueryEnabled");
    expect(source).toContain("finalizationQuery.stale()");
    expect(source).toContain("finalizationQuery.refreshing()");
    expect(source).toContain("onChanged={refreshAfterFinalizationMutation}");
    expect(source.match(/props\.onUpdated\(context\.rec\)/g)).toHaveLength(2);
    expect(source).toContain("disabled={resolutionLoading()}");
    expect(source).toContain("Previous request no longer applies");
    expect(source).toContain('title: "Finalize record?"');
    expect(source).toContain("After finalization, this record and its files and relations can no longer be changed or removed.");
    expect(source).toContain("!rec.finalizedAt");
    expect(source).toContain("showFinalizationStatus={Boolean(rec.finalizedAt || finalization()?.enabled)}");
    expect(source).toContain("record()?.id === result.originalRecordId");
    expect(source).toContain("createCorrectionMut.abort()");
    expect(source).toContain('intent === "cancellation" ? "Create cancellation Draft" : "Create correction Draft"');
    expect(source).toContain('sharedRecordActionIntent() === "cancellation"');
    expect(source).toContain("Grids does not calculate amounts, taxes, or counter-bookings, and it does not generate a Document.");
    expect(source).toContain("onCleanup(() =>");
  });

  test("keeps activation next to Durable History with shared feedback and confirmation", async () => {
    const settingsSource = await Bun.file(new URL("../dialogs/TableAdminDialogs.tsx", import.meta.url)).text();
    const dialogSource = await Bun.file(new URL("../dialogs/HistoryProtectionDialog.tsx", import.meta.url)).text();

    expect(settingsSource).toContain('title="Data integrity"');
    expect(settingsSource).toContain("<DetailPanel.Action");
    expect(settingsSource).toContain('title="History and protection"');
    expect(settingsSource).not.toContain(".finalization.$get");
    expect(settingsSource).not.toContain('["durable-history"].$get');
    expect(dialogSource).toContain("query.create");
    expect(dialogSource).toContain("Promise.all");
    expect(dialogSource).not.toContain("onMount");
    expect(dialogSource).not.toContain("setHistoryStatus");
    expect(dialogSource).not.toContain("setFinalizationStatus");
    expect(dialogSource).toContain("<NoticeCard");
    expect(dialogSource).toContain('title="Keep a history, then lock finished records"');
    expect(dialogSource).toContain('"Durable history is on"');
    expect(dialogSource).toContain("<InlineGuidance");
    expect(dialogSource).toContain('title="Durable history"');
    expect(dialogSource).toContain('title="Record finalization"');
    expect(dialogSource).toContain(".finalization.enable.$post");
    expect(dialogSource).toContain("json:");
    expect(dialogSource).toContain('mode: "fourEyes", approverGroupId: approverGroup()!.id');
    expect(dialogSource).toContain(".finalization.disable.$post");
    expect(dialogSource).toContain(".finalization.policy.$put");
    expect(dialogSource).toContain("<Select");
    expect(dialogSource).toContain("People with Write access can finalize Records themselves.");
    expect(dialogSource).toContain("One person requests Finalization; a different approver reviews it.");
    expect(dialogSource).toContain('types={["group"]}');
    expect(dialogSource).toContain('title: operation === "enable" ? "Enable record finalization?" : "Disable record finalization?"');
  });

  test("does not expose finalized Custom App records as editable", async () => {
    const source = await Bun.file(new URL("../../custom-app/RecordDetails.island.tsx", import.meta.url)).text();

    expect(source).toContain("!record().finalizedAt");
    expect(source).toContain("canWrite={editableFieldIds.has(field.id) && !record().finalizedAt}");
  });

  test("shows a calm Draft or Finalized status only for opted-in live records", async () => {
    const source = await Bun.file(new URL("./RecordReadView.tsx", import.meta.url)).text();

    expect(source).toContain('mode() === "live" && props.showFinalizationStatus');
    expect(source).toContain('props.record.finalizedAt ? "Finalized" : "Finalization on · Draft"');
  });
});
