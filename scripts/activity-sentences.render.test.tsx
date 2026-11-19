import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { recordMessages } from "../packages/grids/src/frontend/_components/records/messages";
import { mailActivityEntry } from "../packages/mail/src/frontend/_components/mail-activity-presentation";
import { mailConversationUiMessages } from "../packages/mail/src/frontend/_components/mail-conversation-ui-messages";
import { mailEventsMessages } from "../packages/mail/src/frontend/_components/mail-events-messages";
import { presentMailEvents } from "../packages/mail/src/frontend/_components/mail-events-presentation";
import type { MailActivityEvent } from "../packages/mail/src/service/collaboration";
import { activityMessages, noteActivitySentences } from "../packages/notebooks/src/frontend/activity-messages";
import { pulseMessages } from "../packages/pulse/src/messages";
import { overviewMessages } from "../packages/spaces/src/frontend/overview-messages";
import { registerSsrTestPlugin } from "../packages/ui/test/ssr-test-plugin";

const root = mkdtempSync(resolve(tmpdir(), "cloud-activity-sentences-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { ActivityList } = await import("../packages/ui/src/content/ActivityList");
const { LocaleProvider } = await import("../packages/ui/src/intl/locale");
const NOW = "2026-11-12T15:31:00Z";
const actor = "Mira Lang";
const person = { id: "mira", displayName: actor, avatarHash: null };
const base: MailActivityEvent = {
  id: "1",
  action: "conversation.comment_created",
  actor: { kind: "user", ...person },
  conversationId: "conversation",
  conversationSubject: "Sommerfest",
  outcome: "confirmed",
  targetType: "conversation",
  targetId: "conversation",
  metadata: {},
  createdAt: NOW,
  assignees: null,
};
const mailVariants: Partial<MailActivityEvent>[] = [
  ...["draft.created", "draft.derived", "draft.discarded"].flatMap((action) => [{ action }, { action, conversationId: null }]),
  { action: "conversation.comment_created" },
  ...["reply", "forward", "new"].map((intent) => ({ action: "message.sent", metadata: { intent, result: "sent" } })),
  ...["failed", "unknown", "partial", "sent_copy_missing"].map((result) => ({ action: "message.sent", metadata: { result } })),
  ...["done", "needs_action"].map((workStatus) => ({
    action: "conversation.work_state_changed",
    metadata: { before: { workStatus: workStatus === "done" ? "needs_action" : "done" }, after: { workStatus } },
  })),
  { action: "conversation.local_tags_added", metadata: { addedTagIds: ["tag"] } },
  { action: "conversation.local_tags_updated" },
  { action: "conversation.unknown" },
  ...[
    { before: [], after: [person], idsBefore: [], idsAfter: ["mira"] },
    { before: [], after: [{ ...person, id: "me" }], idsBefore: [], idsAfter: ["me"] },
    { before: [], after: [{ ...person, id: "other" }], idsBefore: [], idsAfter: ["other"] },
    { before: [person], after: [], idsBefore: ["mira"], idsAfter: [] },
    { before: [person], after: [{ ...person, id: "other" }], idsBefore: ["mira", "other"], idsAfter: ["other"] },
  ].map((v) => ({
    action: "conversation.collaboration_updated",
    assignees: { before: v.before, after: v.after },
    metadata: { before: { assigneeUserIds: v.idsBefore }, after: { assigneeUserIds: v.idsAfter } },
  })),
];

// These are the Grids row labels, including every action mapped by its renderer.
const gridsKeys = [
  "created",
  "updated",
  "deleted",
  "restored",
  "imported",
  "fileAdded",
  "fileReplaced",
  "fileRemoved",
  "recordFinalized",
  "snapshotCreated",
  "documentCreated",
  "workflowCreated",
  "workflowUpdated",
  "workflowDeleted",
  "workflowFinalization",
  "documentLinkCreated",
  "documentLinkRevoked",
  "documentLinkAccessed",
] as const;

test("all five apps render standalone activity sentences after an actor in DE and EN", () => {
  for (const locale of ["de", "en"]) {
    const samples: Array<[string, string]> = [];
    const spaces = overviewMessages.resolve([locale]).t;
    const spaceParams = { title: "Sommerfest", space: "Stadtpark", from: "Jonas Weber", action: "Geändert", name: "Plan", count: 2 };
    for (const [key, value] of Object.entries(spaces)) {
      if (key.startsWith("activity") && typeof value === "function") samples.push([`Spaces/${key}`, value(spaceParams)]);
    }
    for (const [key, value] of Object.entries(activityMessages.resolve([locale]).t))
      samples.push([`Notebooks/overview/${key}`, value({ target: "Plan", notebook: "Stadtpark", self: false, overview: true })]);
    for (const [key, value] of Object.entries(noteActivitySentences.resolve([locale]).t)) samples.push([`Notebooks/note/${key}`, value]);
    const pulse = pulseMessages.resolve([locale]).t;
    const pulseSamples = {
      overviewActivitySourceCreated: pulse.overviewActivitySourceCreated({ name: "Import" }),
      overviewActivitySourceUpdated: pulse.overviewActivitySourceUpdated({ name: "Import" }),
      overviewActivitySourceRemoved: pulse.overviewActivitySourceRemoved({ name: "Import" }),
      overviewActivityQuerySaved: pulse.overviewActivityQuerySaved({ name: "Import" }),
      overviewActivityQueryDeleted: pulse.overviewActivityQueryDeleted({ name: "Import" }),
      overviewActivityAlertSaved: pulse.overviewActivityAlertSaved({ name: "Import" }),
      overviewActivityAlertDeleted: pulse.overviewActivityAlertDeleted({ name: "Import" }),
      overviewActivityAlertState: pulse.overviewActivityAlertState({ name: "Import", state: "Warnung" }),
      overviewActivityAlertChanged: pulse.overviewActivityAlertChanged({ name: "Import" }),
      overviewActivitySourceStale: pulse.overviewActivitySourceStale({ name: "Import" }),
      overviewActivitySourceCurrent: pulse.overviewActivitySourceCurrent({ name: "Import" }),
      overviewActivitySourceFreshness: pulse.overviewActivitySourceFreshness({ name: "Import" }),
      overviewActivityUnknown: pulse.overviewActivityUnknown({ kind: "Import" }),
    };
    expect(
      Object.keys(pulse)
        .filter((key) => key.startsWith("overviewActivity") && key !== "overviewActivityKeyState")
        .sort(),
    ).toEqual(Object.keys(pulseSamples).sort());
    samples.push(...Object.entries(pulseSamples).map(([key, value]): [string, string] => [`Pulse/${key}`, value]));
    const grids = recordMessages.resolve([locale]).t;
    for (const key of gridsKeys) samples.push([`Grids/${key}`, grids[key]]);
    const gridsSource = readFileSync(
      resolve(import.meta.dir, "../packages/grids/src/frontend/_components/records/RecordHistorySection.tsx"),
      "utf8",
    );
    const labels = gridsSource.slice(gridsSource.indexOf("const labels:"), gridsSource.indexOf("return labels[action]"));
    expect([...labels.matchAll(/: t\.([A-Za-z]+)/g)].map((match) => match[1]).sort()).toEqual([...gridsKeys].sort());
    const mail = presentMailEvents(
      mailVariants.map((v, i) => ({ ...base, ...v, id: String(i) })),
      {
        locale,
        now: new Date(NOW),
        currentUserId: "me",
        dateConfig: { locale, timeZone: "UTC" },
        tagName: () => "Priorität",
      },
    );
    // Every sentence fragment in the event catalog must be exercised by a complete real presenter row.
    const exercised = new Set(mail.map((row) => row.before));
    for (const [key, value] of Object.entries(mailEventsMessages.resolve([locale]).t)) {
      if ((key.endsWith("Before") || key === "draftStartedNew" || key === "draftDiscardedNew") && typeof value === "string")
        expect(exercised.has(value), `Mail/${locale}/${key}`).toBe(true);
    }
    samples.push(...mail.map((row): [string, string] => [`Mail/events/${row.event.id}`, `${row.before}${row.subject ?? ""}${row.after}`]));
    const conversation = mailConversationUiMessages.resolve([locale]).t;
    for (const [key, value] of Object.entries(conversation)) {
      if (key.startsWith("activity") && key !== "activityAnd" && typeof value === "string")
        samples.push([`Mail/conversation/${key}`, value]);
    }
    expect(
      Object.entries(conversation)
        .filter(([key, value]) => key.startsWith("activity") && typeof value === "function")
        .map(([key]) => key)
        .sort(),
    ).toEqual(["activityMarked", "activityRepeated"]);
    samples.push(["Mail/conversation/activityMarked", conversation.activityMarked({ status: "Erledigt" })]);
    samples.push(["Mail/conversation/activityRepeated", conversation.activityRepeated({ label: "Kommentar ergänzt", count: 2 })]);
    for (const [key, sentence] of samples) {
      const label = `${locale}/${key}`;
      expect(sentence.trim().length, label).toBeGreaterThan(0);
      expect(sentence.trim(), label).not.toMatch(/^(?:hat|hast|haben|has|have|had|he|she|they)\b|^[–—·-]/i);
      const html = renderToString(() =>
        createComponent(LocaleProvider, {
          locale,
          get children() {
            return createComponent(ActivityList.Row, { entry: { at: NOW, actor, text: sentence }, now: NOW, timeZone: "UTC" });
          },
        }),
      );
      let rendered = "";
      new HTMLRewriter()
        .on(".k2b-activity__text", {
          text(chunk) {
            rendered += chunk.text;
          },
        })
        .transform(html);
      expect(rendered, label).toBe(`${actor} · ${sentence}`);
      expect(html, label).not.toContain(" title=");
    }
    expect(samples.length).toBeGreaterThan(100);
    const workflow = presentMailEvents(
      [{ ...base, actor: { kind: "workflow", id: null, displayName: "Importdienst", avatarHash: null } }],
      { locale, now: new Date(NOW), currentUserId: "me", dateConfig: { locale, timeZone: "UTC" }, tagName: () => undefined },
    );
    expect(workflow[0]?.actorLabel).toBe("Importdienst");
    expect(
      mailActivityEntry({ ...base, actor: { kind: "workflow", id: null, displayName: "Importdienst", avatarHash: null } }, locale).actor,
    ).toBe("Importdienst");
  }
});
