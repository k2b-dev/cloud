import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-discussion-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: Discussion } = await import("./Discussion");

describe("Discussion", () => {
  test("renders portable discussion structure without domain behavior", () => {
    const html = renderToString(() =>
      createComponent(Discussion, {
        label: "Notes",
        icon: "ti ti-note",
        count: 2,
        actions: "Add note",
        get children() {
          return [
            createComponent(Discussion.Composer, {
              label: "Add note",
              submitLabel: "Post note",
              onSubmit: () => undefined,
            }),
            createComponent(Discussion.List, {
              get children() {
                return createComponent(Discussion.Item, {
                  author: "Mara Klein",
                  avatar: "MK",
                  "aria-busy": "true",
                  timestamp: "18 min ago",
                  meta: "edited",
                  replyContext: "Reply to Alex Smith",
                  actions: "Edit Delete",
                  children: "Purchase order requested.",
                });
              },
            }),
          ];
        },
      }),
    );

    // A discussion is a Section: the same frame, heading, and region name as the topics beside it.
    expect(html).toMatch(
      /<section[^>]+class="k2b-section k2b-discussion[^"]*"[^>]+data-frame="line"[^>]+aria-labelledby="k2b-section-[^"]+"/,
    );
    expect(html).toMatch(/<h3[^>]*class="k2b-section__title/);
    expect(html).toContain('class="k2b-discussion__composer');
    expect(html).toContain('class="k2b-discussion__composer-field" data-has-inset-action="true"');
    expect(html).toContain('class="k2b-discussion__composer-inset-action"');
    expect(html).toContain('class="k2b-discussion__list"');
    expect(html).toContain('data-has-avatar="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-visibility="progressive"');
    expect(html).toContain("Reply to Alex Smith");
  });

  test("owns the Markdown composer and inset submit action", async () => {
    const html = renderToString(() =>
      createComponent(Discussion.Composer, {
        label: "Add note",
        submitLabel: "Post note",
        onSubmit: () => undefined,
      }),
    );
    const css = await Bun.file(resolve(import.meta.dir, "../styles/index.css")).text();
    const insetRule = css.match(/\.k2b-ui \.k2b-discussion__composer-inset-action \{([^}]*)\}/)?.[1];

    expect(html).toContain('data-has-inset-action="true"');
    expect(html).toContain("Post note");
    expect(html).not.toContain("<footer");
    expect(insetRule).toContain("position: absolute");
    expect(insetRule).toContain("right: 0.5rem");
    expect(insetRule).toContain("bottom: 0.5rem");
    expect(css).toContain('.k2b-discussion__composer-field[data-has-inset-action="true"]');
    expect(css).toContain("padding-right: 3rem !important");
    expect(css).toContain("overflow-y: auto !important");
    expect(css).not.toContain("padding-bottom: 3rem !important");
  });

  test("supports a bare page section without changing the default surface", async () => {
    const html = renderToString(() =>
      createComponent(Discussion, {
        label: "Questions and updates",
        as: "h2",
        surface: "bare",
        children: createComponent(Discussion.List, {}),
      }),
    );
    const css = await Bun.file(resolve(import.meta.dir, "../styles/index.css")).text();
    const bareTitle = css.match(
      /\.k2b-ui \.k2b-discussion\[data-surface="bare"\] > \.k2b-section__header \.k2b-section__title \{([^}]*)\}/,
    )?.[1];

    expect(html).toContain('data-surface="bare"');
    // A bare discussion stands flat on its page with a larger title.
    expect(html).toContain('data-frame="none"');
    expect(html).toMatch(/<h2[^>]*>Questions and updates<\/h2>/);
    expect(bareTitle).toContain("font-size: 1rem");
  });

  test("keeps item actions visible on touch and progressive on hovering pointers", async () => {
    const css = await Bun.file(resolve(import.meta.dir, "../styles/index.css")).text();
    const actionRule = css.match(/\.k2b-ui \.k2b-discussion__item-actions \{([^}]*)\}/)?.[1];

    expect(actionRule).toContain("opacity: 1");
    expect(css).toContain("@media (any-hover: hover)");
    expect(css).toContain(':where(html:not([data-k2b-input="touch"])) .k2b-ui .k2b-discussion__item-actions');
    expect(css).toContain(':where(html[data-k2b-input="trackpad"]) .k2b-ui .k2b-discussion__item-actions');
    expect(css).toContain('.k2b-discussion__item-actions[data-visibility="progressive"]');
    expect(css).toContain(".k2b-discussion__item:focus-within");
    expect(css).toContain("width: 1.25rem");
    expect(css).toContain("font-size: 0.6875rem");
  });

  test("reads an empty discussion as one header line and folds older entries above the newest", () => {
    const empty = renderToString(() =>
      createComponent(Discussion, {
        label: "Comments",
        icon: "ti ti-message",
        count: 0,
        actions: "Comment",
        get children() {
          return createComponent(Discussion.List, {});
        },
      }),
    );
    expect(empty).toContain('<span class="k2b-section__none">None yet</span>');
    expect(empty).not.toContain(">0<");

    const folded = renderToString(() =>
      createComponent(Discussion.List, {
        fold: 3,
        get children() {
          return ["A", "B", "C", "D", "E"].map((author) => createComponent(Discussion.Item, { author, children: `From ${author}` }));
        },
      }),
    );
    expect(folded).toContain("Show 2 older");
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).not.toContain("From A");
    expect(folded).not.toContain("From B");
    expect(folded).toContain("From C");
    expect(folded).toContain("From E");
    // The toggle comes before the entries, so expanding never moves anything above it.
    expect(folded.indexOf("k2b-discussion__fold")).toBeLessThan(folded.indexOf("From C"));

    // A failed refresh keeps the loaded entries, and with them the way to the older ones.
    const failed = renderToString(() =>
      createComponent(Discussion.List, {
        fold: 3,
        error: "Comments could not be refreshed.",
        get children() {
          return ["A", "B", "C", "D", "E"].map((author) => createComponent(Discussion.Item, { author, children: `From ${author}` }));
        },
      }),
    );
    expect(failed).toContain("Comments could not be refreshed.");
    expect(failed).toContain("Show 2 older");
  });
});
