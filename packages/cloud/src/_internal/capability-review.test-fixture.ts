import { z } from "zod";
import {
  CAPABILITY_MAX_REVIEW_BYTES,
  CapabilityActionCheckSchema,
  type CapabilityActionPolicy,
  type CapabilityActionReview,
} from "../contracts/capabilities";
import { compileCapabilities } from "./capabilities";

export const reviewFixture = (): CapabilityActionReview => ({
  locale: "en",
  sentence: {
    action: "Send {subject} to {to}",
    running: "Sending {subject} to {to}",
    done: "Queued {subject} to {to}",
    confirm: "Send to {to}",
    decline: "Keep draft",
  },
  slots: {
    subject: { kind: "object", title: "Meeting.pdf" },
    to: { kind: "person", people: [{ name: "Lea", address: "lea@example.com" }] },
  },
  preview: {
    kind: "message",
    from: { name: "Ops", address: "ops@example.com" },
    to: [{ name: "Lea", address: "lea@example.com" }],
    subject: "Meeting",
    body: "Hello\nLea\t!",
    format: "plain",
  },
});
export const compileReviewFixture = (policy: CapabilityActionPolicy | null = { ask: "sends" }) =>
  compileCapabilities("demo", {
    protocolVersion: 2,
    presentation: { baseLocale: "en", translations: { de: {} } },
    queries: {
      other: {
        title: "Other",
        description: "Different result data.",
        openWorld: false,
        input: z.object({}).strict(),
        data: z.object({ other: z.string() }).strict(),
        run: () => ({ ok: true, data: { data: { other: "x" } } }),
      },
      check: {
        title: "Check",
        description: "Check the outcome.",
        openWorld: false,
        input: z.object({ id: z.string().describe("Item ID") }).strict(),
        data: CapabilityActionCheckSchema,
        run: () => ({ ok: true, data: { data: { outcome: "pending" } } }),
      },
    },
    actions: {
      send: {
        title: "Send",
        description: "Send the message.",
        input: z.object({}).strict(),
        data: z.object({}).strict(),
        destructive: false,
        openWorld: false,
        idempotency: "required",
        ...(policy ? { policy } : { approval: "rememberable" as const }),
        review: () => ({ ok: true, data: reviewFixture() }),
        run: () => ({ ok: true, data: { data: {} } }),
      },
    },
  });

/** Identical malformed wire values exercise producer and Core, including refinements lost by JSON Schema. */
export const reviewCases = (): Array<{ name: string; review: object; valid: boolean; policy?: CapabilityActionPolicy | null }> => {
  const base = reviewFixture();
  const change = (name: string, extra: object, valid = false) => ({ name, review: { ...base, ...extra }, valid });
  const form = (name: string, text: string) => change(name, { sentence: { ...base.sentence, [name.split(" ")[0]!]: text } });
  return [
    change("valid", {}, true),
    ...["rejected", "notRun", "short"].map((form) =>
      change(`optional ${form} explicitly undefined`, { sentence: { ...base.sentence, [form]: undefined } }, true),
    ),
    ...previewBoundaryCases().map(({ name, preview, valid }) =>
      change(name, { preview, links: [{ rel: "open", href: "/app/demo" }] }, valid),
    ),
    ...slotBoundaryCases().map(({ name, slot, valid }) => change(name, { slots: { ...base.slots, subject: slot } }, valid)),
    ...[6, 7].map((count) => {
      const slots = Object.fromEntries(Array.from({ length: count }, (_, i) => [`s${i}`, { kind: "text", value: "X" }]));
      const text = Object.keys(slots)
        .map((key) => `{${key}}`)
        .join(" ");
      return change(
        `slot count ${count}`,
        { slots, sentence: { ...base.sentence, action: text, running: text, done: text, confirm: "Go" } },
        count === 6,
      );
    }),
    ...[3, 4].map((count) => {
      const slots = Object.fromEntries(Array.from({ length: count }, (_, i) => [`s${i}`, { kind: "object", title: "X" }]));
      const text = Object.keys(slots)
        .map((key) => `{${key}}`)
        .join(" ");
      return change(
        `chip count ${count}`,
        { slots, sentence: { ...base.sentence, action: text, running: text, done: text, confirm: "Go" } },
        count === 3,
      );
    }),
    ...[200, 201].map((length) =>
      change(
        `template length ${length}`,
        { sentence: { ...base.sentence, action: "x".repeat(length - 14) + "{subject} {to}" } },
        length === 200,
      ),
    ),
    ...[60, 61].map((length) =>
      change(`short length ${length}`, { sentence: { ...base.sentence, short: "x".repeat(length) } }, length === 60),
    ),
    ...[40, 41].map((length) =>
      change(`button rendered length ${length}`, { sentence: { ...base.sentence, decline: "x".repeat(length) } }, length === 40),
    ),
    ...[10, 11].map((length) =>
      change(`links length ${length}`, { links: Array.from({ length }, () => ({ rel: "open", href: "/app/demo" })) }, length === 10),
    ),
    ...[6, 7].map((length) =>
      change(`consequences length ${length}`, { consequences: Array.from({ length }, () => ({ text: "Done" })) }, length === 6),
    ),
    ...[200, 201].map((length) => change(`scope length ${length}`, { scope: "x".repeat(length) }, length === 200)),
    change("effects minimum", { effects: 1 }, true),
    change("check wrong data schema", { check: { query: "other", input: {} } }),
    change("check action instead of query", { check: { query: "send", input: {} } }),
    ...[false, true].map((over) => ({ name: `32 KiB ${over ? "over" : "under"}`, review: byteBoundaryReview(over), valid: !over })),
    ...["you", "draft", "shared"].map((reach) => ({
      ...change(`silent reach ${reach}`, { reach }, reach !== "shared"),
      policy: { silent: "draft" } as const,
    })),
    { ...change("silent with per-call ask", { ask: "sends" }, true), policy: { silent: "you" } as const },

    { name: "legacy shape on policy", review: { message: "Send?" }, valid: false },
    { name: "new shape on legacy", review: base, valid: false, policy: null },
    { name: "legacy shape on legacy", review: { message: "Send?", approvalScope: "demo" }, valid: true, policy: null },
    ...["to", "cc", "bcc"].flatMap((field) =>
      [100_000, 100_001].map((count) =>
        change(
          `more.${field} ${count}`,
          { preview: { ...base.preview, more: { [field]: count } }, links: [{ rel: "open", href: "/app/demo" }] },
          count === 100_000,
        ),
      ),
    ),
    ...[100_000, 100_001].map((count) =>
      change(
        `moreAttachments ${count}`,
        { preview: { ...base.preview, moreAttachments: count }, links: [{ rel: "open", href: "/app/demo" }] },
        count === 100_000,
      ),
    ),
    ...["action", "running", "done"].flatMap((key) => [
      change(`${key} missing slot`, { sentence: { ...base.sentence, [key]: "Send {subject}" } }),
      change(`${key} unknown slot`, { sentence: { ...base.sentence, [key]: "{subject} {to} {other}" } }),
    ]),
    ...["{Subject}", "{subject.name}", "{subject", "{{subject}}", "{subject} }", "{}", "{a_b}"].map((text) =>
      form("action invalid braces " + text, text),
    ),
    form("action template bound", "x".repeat(201) + "{subject} {to}"),
    form("short bound", "x".repeat(61)),
    form("confirm two slots", "{subject} {to}"),
    form("decline rendered bound", "x".repeat(41)),
    ...["\n", "\t", "\u0000", "\u202e", "\u2028", "\u2029"].map((unsafe) =>
      form("action unsafe " + JSON.stringify(unsafe), `Send {subject} ${unsafe} {to}`),
    ),
    change("unknown slot kind", { slots: { ...base.slots, subject: { kind: "future", title: "X" } } }),
    change("invalid slot name", { slots: { ...base.slots, Bad: { kind: "text", value: "x" } } }),
    change("object title empty", { slots: { ...base.slots, subject: { kind: "object", title: "" } } }),
    change("object title bound", { slots: { ...base.slots, subject: { kind: "object", title: "x".repeat(201) } } }),
    change("object icon", { slots: { ...base.slots, subject: { kind: "object", title: "x", icon: "bad" } } }),
    change("object ref", { slots: { ...base.slots, subject: { kind: "object", title: "x", ref: { type: "bad", id: "x" } } } }),
    change("place gone", { slots: { ...base.slots, subject: { kind: "place", title: "x", gone: true } } }),
    change("person empty", { slots: { ...base.slots, to: { kind: "person", people: [] } } }),
    change("person missing identity", { slots: { ...base.slots, to: { kind: "person", people: [{}] } } }),
    change("person uuid", { slots: { ...base.slots, to: { kind: "person", people: [{ name: "x", userId: "bad" }] } } }),
    change("person total", { slots: { ...base.slots, to: { kind: "person", people: [{ name: "x" }], total: 0 } } }),
    change("time invalid day", { slots: { ...base.slots, subject: { kind: "time", start: "2026-02-30", format: "date" } } }),
    change("time without offset", {
      slots: { ...base.slots, subject: { kind: "time", start: "2026-10-17T12:00:00", format: "date-time" } },
    }),
    change("time reverse", { slots: { ...base.slots, subject: { kind: "time", start: "2026-10-17", end: "2026-10-16", format: "date" } } }),
    change("count fraction", { slots: { ...base.slots, subject: { kind: "count", value: 1.5, noun: { other: "items" } } } }),
    change("count noun missing", { slots: { ...base.slots, subject: { kind: "count", value: 1, noun: { one: "item" } } } }),
    change("text unsafe", { slots: { ...base.slots, subject: { kind: "text", value: "x\u202e" } } }),
    change("locale noncanonical", { locale: "DE-ch" }),
    change("locale invalid", { locale: "what_ever" }),
    change("locale invalid with Intl button", {
      locale: "what_ever",
      sentence: { ...base.sentence, confirm: "{subject}" },
      slots: { ...base.slots, subject: { kind: "count", value: 2, noun: { other: "items" } } },
    }),
    change("locale unsupported", { locale: "fr" }),
    change("locale fallback", { locale: "de-CH" }, true),
    change("ask unknown", { ask: "future" }),
    change("reach on ask", { reach: "you" }),
    change("effects zero", { effects: 0 }),
    change("effects fraction", { effects: 1.1 }),
    change("effects max", { effects: 1001 }),
    change("effects boundary", { effects: 1000 }, true),
    change("scope empty", { scope: "" }),
    change("scope max", { scope: "x".repeat(201) }),
    change("links max", { links: Array.from({ length: 11 }, () => ({ rel: "open", href: "/app/demo" })) }),
    change(
      "consequence valid own slots",
      { consequences: [{ text: "Saved {item}", slots: { item: { kind: "object", title: "Report" } }, mark: "added" }] },
      true,
    ),
    change("consequence unknown slot", { consequences: [{ text: "Saved {missing}" }] }),
    change("consequence unsafe", { consequences: [{ text: "Saved\u202e" }] }),
    change(
      "rule valid own slots",
      {
        preview: {
          kind: "rule",
          when: { text: "When {item} changes", slots: { item: { kind: "object", title: "Task" } } },
          does: "Update\n\tTask",
          may: [{ text: "Read {place}", slots: { place: { kind: "place", title: "Team" } } }],
          seesChat: false,
        },
      },
      true,
    ),
    change("rule may unknown slot", {
      preview: { kind: "rule", when: { text: "On update" }, does: "Work", may: [{ text: "Read {missing}" }], seesChat: false },
    }),
    change("single person address unsafe", {
      slots: { ...base.slots, to: { kind: "person", people: [{ address: "lea\n@example.com" }] } },
    }),
    change("object gone false", { slots: { ...base.slots, subject: { kind: "object", title: "X", gone: false } } }),
    change("consequence missing slot", { consequences: [{ text: "No slot", slots: { x: { kind: "text", value: "x" } } }] }),
    change("consequences max", { consequences: Array.from({ length: 7 }, () => ({ text: "Consequence" })) }),
    change("check valid", { check: { query: "check", input: { id: "x" } } }, true),
    change("check unknown", { check: { query: "missing", input: {} } }),
    change("check input", { check: { query: "check", input: { id: 4 } } }),
    ...["from", "moreBcc", "attachments", "truncated"].flatMap((key) => {
      const preview = {
        kind: "message",
        to: [{ address: "lea@example.com" }],
        subject: "Test",
        body: "Hello",
        format: "plain",
        ...(key === "from" ? {} : { from: { address: "ops@example.com" } }),
        ...(key === "moreBcc"
          ? { more: { bcc: 1 } }
          : key === "attachments"
            ? { moreAttachments: 1 }
            : key === "truncated"
              ? { truncated: true }
              : {}),
      };
      return [
        change(`sends ${key} missing completeness`, { preview }),
        ...(key !== "from" ? [change(`sends ${key} open`, { preview, links: [{ rel: "open", href: "/app/demo" }] }, true)] : []),
      ];
    }),
    change("multiline preview", { preview: { kind: "page", title: "Page", body: "Line\n\tText", format: "plain" } }, true),
    change("multiline unsafe", { preview: { kind: "page", title: "Page", body: "Line\u0000Text", format: "plain" } }),
    change("single line unsafe", { preview: { kind: "file", name: "File\nName" } }),
    change("page truncated", { preview: { kind: "page", title: "Page", body: "Text", format: "plain", truncated: true } }),
    change("preview bounds", { preview: { kind: "page", title: "Page", body: "x".repeat(10001), format: "plain" } }),
    change("event zone", { preview: { kind: "event", title: "Event", start: "2026-10-17", timeZone: "Never/Here" } }),
    change("task checklist bound", {
      preview: { kind: "task", title: "Task", checklist: Array.from({ length: 21 }, () => ({ label: "Item", done: false })) },
    }),
    change("fields bound", { preview: { kind: "fields", rows: [] } }),
    change("rule when", { preview: { kind: "rule", when: { text: "{missing}" }, does: "Work", may: [], seesChat: false } }),
  ];
};

const byteBoundaryReview = (over: boolean): CapabilityActionReview => {
  const review = reviewFixture();
  const changes = [2000, 2000, 2000, 0].map((count) => ({ change: "added" as const, text: "é".repeat(count) }));
  review.preview = { kind: "page", title: "Page", body: "é".repeat(10_000), format: "plain", changes };
  const bytes = new TextEncoder().encode(JSON.stringify(review)).byteLength;
  changes[3]!.text = "x".repeat(CAPABILITY_MAX_REVIEW_BYTES - bytes + (over ? 1 : -1));
  return review;
};

const slotBoundaryCases = () => {
  const cases: Array<{ name: string; slot: object; valid: boolean }> = [];
  const bound = (name: string, max: number, build: (n: number) => object, min = 1) => {
    for (const n of [min, max, max + 1]) cases.push({ name: `slot ${name} ${n}`, slot: build(n), valid: n <= max });
  };
  bound("object title", 200, (n) => ({
    kind: "object",
    title: "x".repeat(n),
    gone: true,
    icon: "ti ti-file",
    ref: { type: "demo.file", id: "x" },
  }));
  bound("place title", 200, (n) => ({ kind: "place", title: "x".repeat(n) }));
  bound("person people", 20, (n) => ({ kind: "person", people: Array.from({ length: n }, () => ({ name: "Lea" })) }));
  bound("person name", 120, (n) => ({ kind: "person", people: [{ name: "x".repeat(n), userId: "11111111-1111-4111-8111-111111111111" }] }));
  bound("person address", 320, (n) => ({ kind: "person", people: [{ address: "x".repeat(n) }] }));
  bound("person total", 100_000, (n) => ({ kind: "person", people: [{ name: "Lea" }], total: n }));
  bound("count value", 1_000_000_000, (n) => ({ kind: "count", value: n, noun: { other: "items" } }), 0);
  bound("count noun", 40, (n) => ({ kind: "count", value: 1, noun: { one: "x".repeat(n), other: "x".repeat(n) } }));
  bound("text value", 200, (n) => ({ kind: "text", value: "x".repeat(n) }));
  for (const slot of [
    { kind: "time", start: "2026-10-17", end: "2026-10-17", format: "date" },
    { kind: "time", start: "2026-10-17T12:00:00+02:00", end: "2026-10-17T10:00:00Z", format: "date-time" },
  ])
    cases.push({ name: `slot valid ${slot.format}`, slot, valid: true });
  for (const format of ["date", "date-time"] as const)
    for (const field of ["start", "end"] as const)
      for (const value of ["tomorrow", "2026-02-30", "2026-10-17T12:00:00", "2026-02-30T12:00:00Z"])
        cases.push({
          name: `slot time ${format}.${field} ${value}`,
          slot: { kind: "time", start: format === "date" ? "2026-10-17" : "2026-10-17T12:00:00Z", format, [field]: value },
          valid: false,
        });
  for (const kind of ["object", "place", "text", "person", "count"]) {
    const slot =
      kind === "object" || kind === "place"
        ? { kind, title: "x\u202e" }
        : kind === "text"
          ? { kind, value: "x\u202e" }
          : kind === "person"
            ? { kind, people: [{ name: "x\u202e" }] }
            : { kind, value: 1, noun: { other: "x\u202e" } };
    cases.push({ name: `slot unsafe ${kind}`, slot, valid: false });
  }
  return cases;
};

export const previewBoundaryCases = () => {
  const cases: Array<{ name: string; preview: object; valid: boolean }> = [];
  const bases = {
    message: {
      kind: "message",
      from: { address: "ops@example.com" },
      to: [{ name: "Lea" }],
      subject: "Hi",
      body: "Hello",
      format: "plain",
    },
    event: { kind: "event", title: "Event", start: "2026-10-17", timeZone: "Europe/Berlin" },
    task: { kind: "task", title: "Task" },
    page: { kind: "page", title: "Page", body: "Text", format: "plain" },
    file: { kind: "file", name: "file.pdf" },
    rule: { kind: "rule", when: { text: "On update" }, does: "Work", may: [], seesChat: false },
  };
  const bound = (kind: keyof typeof bases, field: string, max: number, build: (n: number) => unknown) => {
    for (const n of [max, max + 1])
      cases.push({ name: `preview ${kind}.${field} ${n}`, preview: { ...bases[kind], [field]: build(n) }, valid: n === max });
  };
  const line = (kind: keyof typeof bases, field: string, max: number) => {
    bound(kind, field, max, (n) => "x".repeat(n));
    cases.push({ name: `preview unsafe ${kind}.${field}`, preview: { ...bases[kind], [field]: "x\n" }, valid: false });
  };
  const block = (kind: keyof typeof bases, field: string, max: number) => {
    bound(kind, field, max, (n) => "x".repeat(n));
    cases.push({ name: `preview multiline ${kind}.${field}`, preview: { ...bases[kind], [field]: "x\n\t" }, valid: true });
    cases.push({ name: `preview unsafe ${kind}.${field}`, preview: { ...bases[kind], [field]: "x\r" }, valid: false });
  };
  for (const field of ["to", "cc", "bcc"]) bound("message", field, 50, (n) => Array.from({ length: n }, () => ({ name: "Lea" })));
  for (const field of ["to", "cc", "bcc"]) bound("message", "more", 100_000, (n) => ({ [field]: n }));

  line("message", "subject", 998);
  block("message", "body", 10_000);
  bound("message", "attachments", 50, (n) => Array.from({ length: n }, () => ({ name: "file.pdf" })));
  bound("message", "attachments", 255, (n) => [{ name: "x".repeat(n) }]);
  bound("message", "warnings", 5, (n) => Array.from({ length: n }, () => "Warning"));
  bound("message", "warnings", 300, (n) => ["x".repeat(n)]);
  for (const field of ["title", "place", "location", "recurrence"]) line("event", field, 200);
  bound("event", "attendees", 50, (n) => Array.from({ length: n }, () => ({ name: "Lea" })));
  block("event", "description", 2000);
  for (const field of ["title", "place"]) line("task", field, 200);
  line("task", "status", 60);
  bound("task", "assignees", 20, (n) => Array.from({ length: n }, () => ({ name: "Lea" })));
  bound("task", "checklist", 20, (n) => Array.from({ length: n }, () => ({ label: "Item", done: false })));
  bound("task", "checklist", 200, (n) => [{ label: "x".repeat(n), done: false }]);
  bound("task", "tags", 10, (n) => Array.from({ length: n }, () => "Tag"));
  bound("task", "tags", 60, (n) => ["x".repeat(n)]);
  block("task", "description", 2000);
  for (const field of ["title", "place"]) line("page", field, 200);
  block("page", "body", 10_000);
  bound("page", "changes", 20, (n) => Array.from({ length: n }, () => ({ change: "added", text: "Change" })));
  bound("page", "changes", 2000, (n) => [{ change: "added", text: "x".repeat(n) }]);
  line("file", "name", 255);
  line("file", "place", 200);
  line("file", "path", 1024);
  line("file", "to", 1024);
  line("file", "mediaType", 120);
  block("rule", "does", 4000);
  bound("rule", "may", 12, (n) => Array.from({ length: n }, () => ({ text: "Can read" })));
  for (const count of [0, 1, 12, 13])
    cases.push({
      name: `preview fields rows ${count}`,
      preview: { kind: "fields", rows: Array.from({ length: count }, () => ({ label: "Title", value: "X" })) },
      valid: count >= 1 && count <= 12,
    });
  for (const [field, max] of [
    ["label", 60],
    ["value", 2000],
    ["before", 2000],
  ] as const)
    for (const n of [max, max + 1])
      cases.push({
        name: `preview fields.${field} ${n}`,
        preview: { kind: "fields", rows: [{ label: "Title", value: "X", [field]: "x".repeat(n) }] },
        valid: n === max,
      });
  const dateValues = [
    { value: "2024-02-29", date: true, dateTime: false },
    { value: "2026-10-17T12:00:00Z", date: true, dateTime: true },
    { value: "2026-10-17T12:00:00+02:00", date: true, dateTime: true },
    { value: "tomorrow", date: false, dateTime: false },
    { value: "2026-02-29", date: false, dateTime: false },
    { value: "2026-02-30T12:00:00Z", date: false, dateTime: false },
    { value: "2026-10-17T12:00:00", date: false, dateTime: false },
  ];
  for (const { value, date, dateTime } of dateValues) {
    for (const format of ["date", "date-time"] as const)
      for (const field of ["value", "before"] as const)
        cases.push({
          name: `preview fields ${format}.${field} ${value}`,
          preview: { kind: "fields", rows: [{ label: "Date", value: "2026-10-17T12:00:00Z", format, [field]: value }] },
          valid: format === "date" ? date : dateTime,
        });
    for (const allDay of [undefined, false, true])
      for (const field of ["start", "end"] as const)
        cases.push({
          name: `preview event ${field} ${value} allDay=${allDay}`,
          preview: { ...bases.event, allDay, [field]: value },
          valid: date,
        });
    cases.push({ name: `preview task due ${value}`, preview: { ...bases.task, due: value }, valid: date });
    cases.push({ name: `preview message sendAt ${value}`, preview: { ...bases.message, sendAt: value }, valid: dateTime });
  }
  return cases;
};

export const outcomeCheckCases = () => [
  { name: "without receipt", result: { data: { outcome: "pending" } }, valid: true },
  {
    name: "own slots",
    result: { data: { outcome: "done", receipt: { text: "Saved {file}", slots: { file: { kind: "object", title: "Saved.pdf" } } } } },
    valid: true,
  },
  { name: "unknown slot", result: { data: { outcome: "done", receipt: { text: "{missing}" } } }, valid: false },
  ...[false, true].map((open) => ({
    name: `truncated preview with open link=${open}`,
    result: {
      data: {
        outcome: "done",
        receipt: { text: "Saved", preview: { kind: "page", title: "Page", body: "Text", format: "plain", truncated: true } },
      },
      ...(open ? { links: [{ rel: "open", href: "/app/demo" }] } : {}),
    },
    valid: open,
  })),
];

export const receiptCases = () => [
  {
    name: "sends receipt without from",
    receipt: {
      text: "Sent",
      preview: { kind: "message", to: [{ name: "Lea" }], subject: "Hi", body: "Hello", format: "plain" },
    },
    links: undefined,
    valid: true,
  },
  {
    name: "valid own slots",
    receipt: { text: "Saved {file}", slots: { file: { kind: "object", title: "Saved.pdf" } } },
    links: undefined,
    valid: true,
  },
  { name: "unknown own slot", receipt: { text: "Saved {missing}" }, links: undefined, valid: false },
  {
    name: "unused own slot",
    receipt: { text: "Saved", slots: { file: { kind: "object", title: "Saved.pdf" } } },
    links: undefined,
    valid: false,
  },
  ...[200, 201].map((n) => ({ name: `receipt template ${n}`, receipt: { text: "x".repeat(n) }, links: undefined, valid: n === 200 })),
  ...[6, 7].map((n) => {
    const slots = Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, { kind: "text", value: "X" }]));
    return {
      name: `receipt slots ${n}`,
      receipt: {
        text: Object.keys(slots)
          .map((key) => `{${key}}`)
          .join(" "),
        slots,
      },
      links: undefined,
      valid: n === 6,
    };
  }),
  ...[3, 4].map((n) => {
    const slots = Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, { kind: "object", title: "X" }]));
    return {
      name: `receipt chips ${n}`,
      receipt: {
        text: Object.keys(slots)
          .map((key) => `{${key}}`)
          .join(" "),
        slots,
      },
      links: undefined,
      valid: n === 3,
    };
  }),
  ...previewBoundaryCases().map(({ name, preview, valid }) => ({
    name,
    receipt: { text: "Saved", preview },
    links: [{ rel: "open", href: "/app/demo" }],
    valid,
  })),
  ...["to", "cc", "bcc", "moreAttachments", "truncated"].flatMap((field) =>
    [false, true].map((open) => ({
      name: `receipt completeness ${field} ${open}`,
      receipt: {
        text: "Sent",
        preview: {
          ...reviewFixture().preview,
          from: undefined,
          ...(field === "truncated"
            ? { truncated: true }
            : field === "moreAttachments"
              ? { moreAttachments: 1 }
              : { more: { [field]: 1 } }),
        },
      },
      links: open ? [{ rel: "open", href: "/app/demo" }] : undefined,
      valid: open,
    })),
  ),
];
