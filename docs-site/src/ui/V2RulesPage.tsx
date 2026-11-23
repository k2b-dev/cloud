import { DocCode } from "@k2b/ui";
import { typeRoles } from "@k2b/ui/v2";
import { For, Show } from "solid-js";

/** A crop of the mockup, taken at device pixel ratio 2; width and height are its CSS size, so nothing moves on load. */
type Excerpt = { src: string; alt: string; width: number; height: number };

type V2Rule = {
  id: string;
  title: string;
  text: string;
  excerpts: readonly Excerpt[];
  /** Set when the rule shows a live example from `@k2b/ui/v2.css` instead of a mockup picture. */
  live?: "type-roles";
  checked: string;
  /** What the check does not see, said plainly. */
  limits?: string;
  /** DocCode highlights TypeScript; CSS shows as plain text. */
  code: { title: string; language: "ts" | "tsx" | "text"; source: string };
};

const rules: readonly V2Rule[] = [
  {
    id: "layout",
    title: "Primitives own spacing, lines and type",
    text: "An app passes data and order. It never sets a gap, a padding, a size or a font. A primitive takes its height and its text edge from the place where it stands.",
    excerpts: [
      { src: "/assets/ui-v2/square.png", alt: "A bar, a row from edge to edge and a notice as a whole cell", width: 522, height: 148 },
    ],
    checked:
      "v2-primitive-props reads the prop types of every component that @k2b/ui/v2 exports, its parts at any depth included, with the compiler options of packages/ui.",
    limits: "A type it cannot resolve, props typed any or unknown, and props with an index signature fail the check instead of passing.",
    code: {
      title: "scripts/checks/v2-primitive-props.ts",
      language: "tsx",
      source: [
        "// Green: places and meanings are props.",
        "type RowProps = {",
        "  title: string;",
        "  lead?: string;",
        '  tone?: "ok" | "bad";',
        "};",
        "",
        "// Red: Row accepts `class`; offer a place",
        "// or a meaning (variant) instead.",
        "type RowProps = { title: string; class?: string };",
      ].join("\n"),
    },
  },
  {
    id: "type",
    title: "Four type roles, three weights",
    text: "A primitive picks a role, never a size: meta for labels and times, row for rows and controls, body for titles and reading text, lead for the one main statement.",
    excerpts: [],
    live: "type-roles",
    checked: "measureV2Layout reports every run of text outside the roles.",
    code: {
      title: "@k2b/ui/v2",
      language: "ts",
      source: [
        "export const typeRoles = {",
        "  meta: { size: 12, lineHeight: 16, weight: 400 },",
        "  row: { size: 13, lineHeight: 20, weight: 400 },",
        "  body: { size: 14, lineHeight: 20, weight: 400 },",
        "  lead: { size: 18, lineHeight: 24, weight: 600 },",
        "} as const;",
        "export const fontWeights = [400, 500, 600] as const;",
      ].join("\n"),
    },
  },
  {
    id: "edge",
    title: "One line, one text edge",
    text: "Every line is 1 px in one colour and runs from edge to edge of its column. Text starts at 20 px, after an icon at 44 px; below 768 px at 16 and 40 px. No container pads its children.",
    excerpts: [
      { src: "/assets/ui-v2/line-edge.png", alt: "A row with an icon, text at 44 px; plain text at 20 px", width: 522, height: 95 },
    ],
    checked: "measureV2Layout reports a line or a tinted band that stops short of its column edge.",
    code: {
      title: "@k2b/ui/v2.css",
      language: "text",
      source: [
        ".k2-ui {",
        "  --k2-hairline: 1px solid var(--k2-line);",
        "  --k2-edge: 20px;",
        "  --k2-edge-icon: calc(var(--k2-edge) + 24px);",
        "}",
        "@media (max-width: 767px) {",
        "  .k2-ui { --k2-edge: 16px; }",
        "}",
      ].join("\n"),
    },
  },
  {
    id: "groups",
    title: "Lines separate groups, not entries",
    text: "No line under the head of a section and none between its entries; one line at its end. What belongs together, such as a delivery, gets one square frame with a tinted head and no line inside.",
    excerpts: [
      {
        src: "/assets/ui-v2/group-lines.png",
        alt: "Section “Anstehend” with two entries and no line between them",
        width: 523,
        height: 167,
      },
      { src: "/assets/ui-v2/group-frame.png", alt: "A framed group with a tinted head and two rows", width: 522, height: 139 },
    ],
    checked: "measureV2Layout reports two lines that lie at most 1 px apart, also when a pseudo-element under display: contents draws one.",
    limits:
      "It measures what is on screen after the page settled. A pseudo-element whose stand-in would change a neighbour (a :last-child rule, for example) is reported as not measurable, never passed.",
    code: {
      title: "A browser test",
      language: "ts",
      source: [
        'import { measureV2Layout } from "@k2b/ui/v2/testing";',
        "",
        "for (const width of [390, 1440])",
        "  test(`${width} px keeps the v2 rules`, async () => {",
        "    await page.setViewportSize({ width, height: 900 });",
        "    expect((await measureV2Layout(page)).problems).toEqual([]);",
        "  });",
      ].join("\n"),
    },
  },
  {
    id: "round",
    title: "Round is what you operate, square is what structures",
    text: "Buttons, fields, segments, chips and entries in a sidebar or menu are round. Columns, bars, bands, rows, cells, tables, sections and groups are square, also when a row opens something. Overlays take 8 px.",
    excerpts: [
      { src: "/assets/ui-v2/round.png", alt: "Round controls: buttons, a field, a segment, a switch, chips", width: 523, height: 77 },
    ],
    checked: "Radii exist only as tokens for marks, controls, overlays and the app card.",
    code: {
      title: "@k2b/ui/v2.css",
      language: "text",
      source: [
        ".k2-ui {",
        "  --k2-r-mark: 4px;",
        "  --k2-r-control: 8px;",
        "  --k2-r-overlay: 8px;",
        "  --k2-r-round: 999px;",
        "  --k2-r-card: 14px;",
        "}",
      ].join("\n"),
    },
  },
  {
    id: "grip",
    title: "A grip sits centred on its line",
    text: "A grip is a round pill of 11 × 20 px over its 1 px line. Its centre is the centre of the line within ±0.25 px, at device pixel ratio 1 and 2. On hover, focus and drag only the colour turns blue.",
    excerpts: [
      // Taken at device pixel ratio 4 and shown twice as large as on screen.
      { src: "/assets/ui-v2/grip.png", alt: "A grip pill centred on the line between list and reader, enlarged", width: 184, height: 160 },
    ],
    checked: "measureV2Layout measures each grip in the DOM and again in a screenshot, inside the grip only.",
    code: {
      title: "A browser test",
      language: "ts",
      source: [
        "for (const deviceScaleFactor of [1, 2]) {",
        "  const page = await browser.newPage({ viewport, deviceScaleFactor });",
        "  const { grips } = await measureV2Layout(page);",
        "  // [{ grip: '[data-k2-grip]', dom: 0, pixels: 0, lineWidth: 1 }]",
        "}",
      ].join("\n"),
    },
  },
  {
    id: "app-css",
    title: "An app writes no layout CSS",
    text: "From its first value import of @k2b/ui/v2, directly or through a local module that re-exports it, a screen has no class, style, spread onto a plain element, styling ref, innerHTML or stylesheet of its own, and no app stylesheet restyles v2. An app may draw freely only inside Canvas, which stands directly in a v2 primitive and never wraps a whole screen.",
    excerpts: [],
    checked: "v2-app-layout-css fails bun run check and the gate. Screens without a v2 import are untouched for now.",
    limits:
      "It reads one file and the local modules it imports directly. Layout in a file without a v2 import, imperative styling outside a ref callback, and CSS that a v1 component brings along stay unseen.",
    code: {
      title: "scripts/checks/v2-app-layout-css.ts",
      language: "tsx",
      source: [
        'import { Band, Canvas, Pane } from "@k2b/ui/v2";',
        "",
        "// Red: class on <div> in a v2 screen",
        '<Pane head={<div class="flex gap-2">Inbox</div>} />',
        "",
        "// Green: free drawing inside Canvas",
        '<Band><Canvas label="Radar"><svg class="radar">…</svg></Canvas></Band>',
      ].join("\n"),
    },
  },
  {
    id: "ui-sdk",
    title: "Only @k2b/ui sees ui-sdk",
    text: "ui-sdk brings keyboard, focus, ARIA and dragging below the primitives. Apps and other packages never import it; they use the primitive that wraps it.",
    excerpts: [],
    checked:
      "v2-no-ui-sdk-outside-ui reports every import, resolve, module mock, stylesheet import and dependency of @ui-sdk/* outside packages/ui.",
    limits: "A module name built at runtime from parts stays unseen.",
    code: {
      title: "scripts/checks/v2-no-ui-sdk-outside-ui.ts",
      language: "ts",
      source: [
        "// Red in packages/mail:",
        'import { createReorder } from "@ui-sdk/core";',
        "",
        "// Green: the primitive that wraps it",
        'import { List } from "@k2b/ui/v2";',
      ].join("\n"),
    },
  },
];

const roleExamples: Record<keyof typeof typeRoles, string> = {
  lead: "the main statement or a name",
  body: "a title in a head, reading text",
  row: "rows and controls",
  meta: "labels, times, counters",
};

export function V2RulesPage(props: { title: string; description: string }) {
  return (
    <article class="ui-showcase ui-reference-showcase">
      <header class="ui-reference-heading">
        <div class="ui-page-heading">
          <p>@k2b/ui/v2 · provisional</p>
          <h1>{props.title}</h1>
        </div>
        <p>{props.description}</p>
      </header>
      <div class="k2b-ui ui-v2-rules">
        <div class="k2-ui ui-v2-rules__scope">
          <p class="k2-t-lead ui-v2-rules__lead">Eight rules, each with an excerpt of the approved mockup and the check that holds it.</p>
          <p class="k2-t-row k2-muted">
            v2 is provisional until the maintainer approves it. The pictures are excerpts of the mockup, the source of every number here.
          </p>
          <For each={rules}>
            {(rule, index) => (
              <section id={rule.id} class="ui-v2-rule" aria-labelledby={`${rule.id}-title`}>
                <div class="ui-v2-rule__text">
                  <h2 id={`${rule.id}-title`} class="k2-t-body k2-strong">
                    {index() + 1}. {rule.title}
                  </h2>
                  <p class="k2-t-row">{rule.text}</p>
                  <p class="k2-t-meta">{rule.checked}</p>
                  <Show when={rule.limits}>{(limits) => <p class="k2-t-meta">Limits: {limits()}</p>}</Show>
                </div>
                <div class="ui-v2-rule__pair">
                  <Show
                    when={rule.live === "type-roles"}
                    fallback={
                      <Show when={rule.excerpts.length > 0}>
                        <figure class="ui-v2-rule__excerpt">
                          <For each={rule.excerpts}>
                            {(excerpt) => (
                              <img src={excerpt.src} alt={excerpt.alt} width={excerpt.width} height={excerpt.height} loading="lazy" />
                            )}
                          </For>
                          <figcaption class="k2-t-meta">Mockup excerpt</figcaption>
                        </figure>
                      </Show>
                    }
                  >
                    <figure class="ui-v2-rule__excerpt">
                      <div class="ui-v2-rule__roles">
                        <For each={["lead", "body", "row", "meta"] as const}>
                          {(role) => (
                            <span class={`k2-t-${role}`}>
                              {role} {typeRoles[role].size}/{typeRoles[role].lineHeight} · {roleExamples[role]}
                            </span>
                          )}
                        </For>
                      </div>
                      <figcaption class="k2-t-meta">Live from @k2b/ui/v2.css</figcaption>
                    </figure>
                  </Show>
                  <DocCode title={rule.code.title} code={rule.code.source} language={rule.code.language} copy />
                </div>
              </section>
            )}
          </For>
        </div>
      </div>
    </article>
  );
}
