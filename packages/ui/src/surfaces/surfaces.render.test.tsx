import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-surfaces-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Avatar } = await import("./Avatar");
const { DescriptionList } = await import("./DescriptionList");
const { LinkCard } = await import("./LinkCard");
const { NotFoundState } = await import("./NotFoundState");
const { NoticeCard } = await import("./NoticeCard");
const { Paper } = await import("./Paper");
const { default: Placeholder } = await import("./Placeholder");
const { ProgressBar } = await import("./ProgressBar");
const { StatCell } = await import("./StatCell");
const { StatGrid } = await import("./StatGrid");
const { StatusBadge } = await import("./StatusBadge");
const { Tag } = await import("./Tag");

const stylesDir = resolve(import.meta.dir, "../styles");
const stylesheets = readdirSync(stylesDir).filter((file) => file.endsWith(".css"));
const baseCss = readFileSync(resolve(stylesDir, "index.css"), "utf8");
const parityCss = readFileSync(resolve(stylesDir, "surfaces-widgets-parity.css"), "utf8");
const ownedSelectors =
  /\.k2b-(paper|avatar|link-card|not-found|notice-card|notice-grid|placeholder|progress|stat-grid|stat-cell|status-badge|widget)/;
const ownedSelectorFiles = new Set(stylesheets.filter((file) => ownedSelectors.test(readFileSync(resolve(stylesDir, file), "utf8"))));

describe("@k2b/ui Cloud-faithful surfaces", () => {
  test("renders a quiet padding-free paper with opt-in elevation and interaction", () => {
    const section = renderToString(() => (
      <Paper as="section" class="project-summary">
        Summary
      </Paper>
    ));
    const link = renderToString(() => (
      <Paper as="a" href="/projects" elevated interactive aria-label="Projects">
        Open
      </Paper>
    ));
    const rule = parityCss.match(/\.k2b-ui \.k2b-paper \{[^}]*\}/)?.[0] ?? "";

    expect(section).toContain("<section");
    expect(section).toContain('class="k2b-paper project-summary');
    expect(link).toContain('href="/projects"');
    expect(link).toContain('data-elevated="true"');
    expect(link).toContain('data-interactive="true"');
    expect(link).toContain('aria-label="Projects"');
    expect(rule).toContain("border: 1px solid color-mix(in srgb, var(--k2b-border) 72%, transparent)");
    expect(rule).toContain("box-shadow: var(--k2b-shadow-surface)");
    expect(rule).not.toContain("padding:");
    expect(parityCss).toContain('.k2b-paper[data-elevated="true"]');
    expect(parityCss).toContain("box-shadow: var(--k2b-shadow-frame)");
    expect(parityCss).toContain('.k2b-paper[data-interactive="true"]:focus-visible');
  });

  test("renders portable tags and semantic description lists", () => {
    const tag = renderToString(() =>
      createComponent(Tag, {
        color: "#7c3aed",
        icon: "ti ti-tag",
        onRemove: () => {},
        removeLabel: "Remove UI",
        children: "UI",
      }),
    );
    const list = renderToString(() =>
      createComponent(DescriptionList, {
        columns: 2,
        layout: "rows",
        actionVisibility: "progressive",
        items: [
          { term: "Owner", description: "Platform team", action: "Open" },
          { term: "Status", description: "Ready" },
        ],
      }),
    );

    expect(tag).toContain("--k2b-choice-color:#7c3aed");
    expect(tag).toContain('aria-label="Remove UI"');
    const selectedTag = renderToString(() =>
      createComponent(Tag, {
        color: "#2563eb",
        icon: "ti ti-point",
        selected: true,
        size: "lg",
        children: "Selected",
      }),
    );
    expect(selectedTag).toContain('data-size="lg"');
    expect(selectedTag).toContain('data-selected="true"');
    expect(selectedTag).toContain("ti ti-check k2b-tag__icon");
    expect(selectedTag).not.toContain("ti ti-point");
    const unselectedTag = renderToString(() =>
      createComponent(Tag, {
        selected: false,
        size: "lg",
        children: "All",
      }),
    );
    expect(unselectedTag).toContain('ti ti-check k2b-tag__icon" data-placeholder="true"');
    expect(baseCss).toContain('.k2b-ui .k2b-tag[data-selected="true"]');
    expect(baseCss).toContain("var(--k2b-choice-color, var(--k2b-action))");
    const selectedTagRule = baseCss.match(/\.k2b-ui \.k2b-tag\[data-selected="true"\] \{([^}]*)\}/)?.[1];
    const tagIconRule = baseCss.match(/\.k2b-ui \.k2b-tag__icon \{([^}]*)\}/)?.[1];
    expect(selectedTagRule).toContain("font-weight: 600");
    expect(selectedTagRule).not.toContain("outline");
    expect(tagIconRule).toContain("width: 1em");
    expect(tagIconRule).toContain("flex: 0 0 1em");
    expect(baseCss).toContain("color: var(--k2b-text);");
    expect(list).toContain("<dl");
    expect(list).toContain("<dt>Owner</dt>");
    expect(list).toContain("<dd>Platform team</dd>");
    expect(list).toContain('data-columns="2"');
    expect(list).toContain('data-layout="rows"');
    expect(list).toContain('data-action-visibility="progressive"');
    const compact = renderToString(() => createComponent(DescriptionList, {
      layout: "compact", size: "sm", items: [{ term: "Project", description: "Operations" }],
    }));
    expect(compact).toContain('data-layout="compact"');
    expect(compact).toContain("<dt>Project</dt>");
    expect(compact).toContain("<dd>Operations</dd>");
  });

  test("keeps Avatar portable while LinkCard exposes the Cloud color contract", () => {
    const avatar = renderToString(() => createComponent(Avatar, { name: "Ada Lovelace", src: "/ada.webp", size: "lg" }));
    const link = renderToString(() =>
      createComponent(LinkCard, {
        href: "/details",
        title: "Runtime",
        description: "Open runtime details",
        icon: "ti ti-server",
        color: "cyan",
      }),
    );

    const initials = renderToString(() => createComponent(Avatar, { name: "Ada Lovelace" }));
    const icon = renderToString(() => createComponent(Avatar, { name: "Workflow", icon: "ti ti-route" }));
    const nameless = renderToString(() => createComponent(Avatar, { name: "   " }));

    expect(avatar).toContain('src="/ada.webp"');
    expect(avatar).toContain('data-size="lg"');
    expect(initials).toContain(">AL<");
    expect(initials).toContain('aria-label="Ada Lovelace avatar"');
    expect(icon).toContain('class="ti ti-route"');
    expect(icon).toContain('aria-label="Workflow avatar"');
    expect(icon).not.toContain(">WO<");
    // An empty name renders Cloud's "?" placeholder, not initials of the
    // accessible-name fallback.
    expect(nameless).toContain(">?<");
    expect(nameless).toContain('aria-label="Unknown user avatar"');
    expect(link).toContain('href="/details"');
    expect(link).toContain('class="k2b-paper k2b-link-card');
    expect(link).toContain('data-interactive="true"');
    expect(link).toContain('data-color="cyan"');
    expect(link).toContain("Open runtime details");
  });

  test("renders the whole-page not-found state without imposing a main landmark", () => {
    const html = renderToString(() =>
      createComponent(NotFoundState, {
        code: "404",
        title: "Page not found",
        description: "This route does not exist.",
        action: { label: "Home", href: "/", icon: "ti ti-arrow-left" },
      }),
    );

    expect(html).toStartWith('<div class="k2b-not-found">');
    expect(html).not.toContain("<main");
    expect(html).toContain("<h1>Page not found</h1>");
    expect(html).toContain('href="/"');
  });

  test("renders persistent notices and an empty-safe responsive compound grid", () => {
    const info = renderToString(() => createComponent(NoticeCard, { title: "Scheduled maintenance", tone: "info" }));
    const neutral = renderToString(() => createComponent(NoticeCard, { title: "Release note", tone: "neutral" }));
    const success = renderToString(() => createComponent(NoticeCard, { children: "Import complete", tone: "success", role: "status" }));
    const notice = renderToString(() =>
      createComponent(NoticeCard, {
        title: "Database unavailable",
        detail: "Retrying in the background.",
        tone: "danger",
      }),
    );
    const empty = renderToString(() =>
      createComponent(NoticeCard.Grid, {
        items: [],
        children: () => createComponent(NoticeCard, { title: "unused" }),
      }),
    );
    const grid = renderToString(() =>
      createComponent(NoticeCard.Grid, {
        items: ["A", "B"],
        children: (title: string) => createComponent(NoticeCard, { title }),
      }),
    );

    expect(info).toContain('data-tone="info"');
    expect(info).toContain("ti ti-info-circle");
    expect(neutral).toContain('data-tone="neutral"');
    expect(neutral).toContain("ti ti-note");
    expect(success).toContain('data-tone="success"');
    expect(success).toContain('role="status"');
    expect(success).toContain("k2b-notice-card__body");
    expect(success).toContain("ti ti-circle-check");
    expect(notice).toContain('data-tone="danger"');
    expect(notice).toContain("ti ti-alert-circle");
    expect(notice).toContain("Retrying in the background.");
    expect(empty).toBe("");
    expect(grid).toContain('data-columns="two"');
    expect(grid.match(/k2b-notice-card/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("preserves placeholder state semantics", () => {
    const loading = renderToString(() =>
      createComponent(Placeholder, { title: "Loading", state: "loading", surface: "paper", variant: "panel" }),
    );
    const error = renderToString(() => createComponent(Placeholder, { description: "Try again.", state: "error", align: "left" }));

    expect(loading).toContain('role="status"');
    expect(loading).toContain('aria-live="polite"');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('data-surface="paper"');
    expect(loading).toContain('class="k2b-paper k2b-placeholder');
    expect(error).not.toContain("k2b-paper");
    expect(error).toContain('role="alert"');
    expect(error).toContain("Try again.");
  });

  test("keeps placeholder icons free of decorative frames", () => {
    const iconDeclarations = [...parityCss.matchAll(/[^{}]*\.k2b-placeholder__icon[^{}]*\{([^}]*)\}/g)].map((match) => match[1] ?? "");

    expect(iconDeclarations.length).toBeGreaterThan(0);
    for (const declarations of iconDeclarations) {
      expect(declarations).not.toMatch(/(?:^|;)\s*(?:background|border(?:-[\w-]+)?):/);
    }
  });

  test("rounds and clamps determinate progress", () => {
    const progress = renderToString(() =>
      createComponent(ProgressBar, { value: 41.6, label: "Upload", size: "xs", tone: "success", showValue: true }),
    );
    const clamped = renderToString(() => createComponent(ProgressBar, { value: 140, label: "Upload" }));
    const invalid = renderToString(() => createComponent(ProgressBar, { value: Number.NaN, label: "Upload" }));

    expect(progress).toContain('aria-valuenow="42"');
    expect(progress).toContain('data-size="xs"');
    expect(progress).toContain('data-tone="success"');
    expect(progress).toContain("42%");
    expect(clamped).toContain('aria-label="Upload"');
    expect(clamped).toContain('aria-valuenow="100"');
    expect(invalid).toContain('aria-valuenow="0"');
  });

  test("renders the semantic status vocabulary and truncatable labels", () => {
    const chip = renderToString(() => createComponent(StatusBadge, { label: "Healthy", tone: "ok" }));
    const dot = renderToString(() =>
      createComponent(StatusBadge, { label: "Running a long task", tone: "running", variant: "dot", title: "Current state" }),
    );
    const text = renderToString(() => createComponent(StatusBadge, { label: "Offline", tone: "error", variant: "text", icon: null }));

    const info = renderToString(() => createComponent(StatusBadge, { label: "Info", tone: "info" }));
    expect(info).toContain('data-tone="info"');
    expect(info).toContain("ti ti-info-circle");
    expect(chip).toContain("ti ti-check");
    expect(chip).toContain('data-variant="chip"');
    expect(dot).toContain("k2b-status-badge__dot");
    expect(dot).toContain('title="Current state"');
    expect(dot).toContain("k2b-status-badge__label");
    expect(text).not.toContain("ti ti-alert-circle");
  });

  test("renders responsive stat grids and prevents nested accent links", () => {
    const html = renderToString(() =>
      createComponent(StatGrid, {
        columns: 7 as unknown as 6,
        title: "Service",
        action: { label: "Details", href: "/details" },
        surface: "muted",
        children: createComponent(StatCell, {
          label: "Latency",
          value: "42 ms",
          valueClass: "latency-warning",
          sub: "p95",
          href: "/latency",
          trend: [10, 30, 20, 42],
          accent: { tone: "amber", icon: "ti ti-alert-triangle", text: "high" },
        }),
      }),
    );

    expect(html).toContain('data-columns="6"');
    expect(html).toContain('class="k2b-paper k2b-stat-grid');
    expect(html).toContain('data-surface="muted"');
    expect(html).toContain('href="/details"');
    expect(html).toContain('href="/latency"');
    expect(html).toContain("latency-warning");
    expect(html).toContain("k2b-stat-cell__trend");
  });

  test("sizes stat cells through the grid context so sub lines scale too", () => {
    // The getter mirrors what JSX children compile to: the cell must render
    // inside StatGrid's providers, or it never sees the grid's size.
    const html = renderToString(() =>
      createComponent(StatGrid, {
        size: "sm",
        columns: 3,
        get children() {
          return createComponent(StatCell, { label: "Runs", value: 4, sub: "today" });
        },
      }),
    );

    expect(html).toContain('data-columns="3"');
    expect(html).toContain('class="k2b-stat-cell" data-size="sm"');
    expect(html).toContain('class="k2b-stat-cell__label" data-size="sm"');
    // Cloud scales the sub line with the cell, so the rule must key off the cell.
    expect(parityCss).toContain('.k2b-ui .k2b-stat-cell[data-size="sm"] .k2b-stat-cell__sub');
  });

  test("ships focus, responsive, dark, and reduced-motion parity hooks", () => {
    expect(parityCss).toContain(":focus-visible");
    expect(parityCss).toContain("@media (min-width: 48rem)");
    expect(parityCss).toContain(".dark .k2b-ui");
    expect(parityCss).toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("keeps the Cloud chrome that earlier ports dropped", () => {
    // Every neutral surface inherits the same flat Cloud paper shadow token.
    const paperRule = parityCss.match(/\.k2b-ui \.k2b-paper \{[^}]*\}/)?.[0] ?? "";
    expect(paperRule).toContain("box-shadow: var(--k2b-shadow-surface)");
    for (const selector of [".k2b-link-card", ".k2b-stat-grid", ".k2b-widget"]) {
      const rule = parityCss.match(new RegExp(`\\.k2b-ui \\${selector} \\{[^}]*\\}`))?.[0] ?? "";
      expect(rule).not.toContain("box-shadow:");
    }
    // Link cards retain a neutral tile; dashboard widgets keep their header
    // glyph directly on the surface to avoid nested chrome.
    expect(parityCss).toMatch(/\.k2b-link-card__icon \{[^}]*background: var\(--k2b-surface-muted\)/);
    expect(parityCss).toMatch(/\.k2b-widget__icon \{[^}]*background: transparent/);
    // `.state-placeholder[data-variant="panel"]` is 13rem/1.5rem, not 14rem/2rem.
    expect(parityCss).toContain('.k2b-placeholder[data-variant="panel"] { min-height: 13rem;');
    // A muted StatGrid tints the frame, never the cells.
    expect(parityCss).not.toContain('.k2b-stat-cell[data-surface="muted"]');
    // ProgressBar is a row: track then optional readout.
    expect(parityCss).toMatch(/\.k2b-progress \{[^}]*flex-direction: row/);
    // WidgetHero is a bare block inside the widget body, not a tinted card.
    expect(parityCss).toMatch(/\.k2b-widget-hero \{[^}]*background: transparent/);
  });

  test("declares every dark rule in all three supported theme forms", () => {
    const incomplete: string[] = [];

    // Every stylesheet that styles a surface or widget — index.css establishes
    // the three accepted forms (`[data-theme="dark"]`, `.k2b-dark`, `.dark`
    // ancestor) and a rule that ships only one of them silently skips consumers
    // using the other two.
    for (const file of stylesheets.filter((name) => ownedSelectorFiles.has(name))) {
      const css = readFileSync(resolve(stylesDir, file), "utf8");
      for (const rule of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        const selectors = (rule[1]?.replace(/\/\*[\s\S]*?\*\//g, "") ?? "")
          .split(",")
          .map((raw) => raw.split(/\s+/).filter(Boolean).join(" "))
          .filter(Boolean);
        for (const selector of selectors) {
          if (!selector.startsWith(".dark .k2b-ui")) continue;
          const rest = selector.slice(".dark .k2b-ui".length);
          const attribute = `.k2b-ui[data-theme="dark"]${rest}`;
          const className = `.k2b-ui.k2b-dark${rest}`;
          if (!selectors.includes(attribute)) incomplete.push(`${file}: missing ${attribute}`);
          if (!selectors.includes(className)) incomplete.push(`${file}: missing ${className}`);
        }
      }
    }

    expect(incomplete).toEqual([]);
  });

  test("declares each surfaces/widgets selector in exactly one stylesheet", () => {
    const owned =
      /^[a-z]*\.k2b-(paper|avatar|link-card|not-found|notice-card|notice-grid|placeholder|progress|stat-grid|stat-cell|status-badge|widget)/;
    const themePrefix = /^(\.k2b-ui\[data-theme="dark"\]|\.k2b-ui\.k2b-dark|\.dark \.k2b-ui|\.k2b-ui) /;
    const owners = new Map<string, Set<string>>();

    for (const file of stylesheets) {
      const css = readFileSync(resolve(stylesDir, file), "utf8");
      for (const rule of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        const selectors = rule[1]?.replace(/\/\*[\s\S]*?\*\//g, "").trim() ?? "";
        if (!selectors || selectors.startsWith("@")) continue;
        for (const raw of selectors.split(",")) {
          const scoped = raw.split(/\s+/).filter(Boolean).join(" ").replace(themePrefix, "");
          // `.k2b-data-panel > .k2b-placeholder` is composition: the container's
          // stylesheet owns it. Only rules headed by one of our own components
          // count, and the light/dark forms of one rule collapse to one key.
          if (!owned.test(scoped.split(/[\s>]/)[0] ?? "")) continue;
          const seen = owners.get(scoped) ?? new Set<string>();
          seen.add(file);
          owners.set(scoped, seen);
        }
      }
    }

    const shared = [...owners].filter(([, files]) => files.size > 1).map(([selector]) => selector);
    expect(shared).toEqual([]);
    expect(owners.size).toBeGreaterThan(40);
  });

  test("emits no inline Tailwind utility classes — the bundle ships none", () => {
    const rendered = [
      renderToString(() => createComponent(Paper, { children: "P" })),
      renderToString(() => createComponent(LinkCard, { href: "/a", title: "A", description: "B", icon: "ti ti-x", color: "blue" })),
      renderToString(() => createComponent(NotFoundState, { code: "404", title: "Gone", action: { label: "Home", href: "/" } })),
      renderToString(() => createComponent(NoticeCard, { title: "T", detail: "D", tone: "warning" })),
      renderToString(() => createComponent(Placeholder, { title: "T", description: "D", state: "loading", surface: "paper" })),
      renderToString(() => createComponent(ProgressBar, { value: 50, label: "Progress", showValue: true })),
      renderToString(() => createComponent(StatusBadge, { label: "L", tone: "ok" })),
      renderToString(() =>
        createComponent(StatGrid, { columns: 2, title: "T", children: createComponent(StatCell, { label: "L", value: 1, sub: "s" }) }),
      ),
    ].join("");

    const foreign = [...rendered.matchAll(/class="([^"]*)"/g)]
      .flatMap((attribute) => (attribute[1] ?? "").split(/\s+/).filter(Boolean))
      .filter((token) => !/^(k2b-|ti$|ti-)/.test(token));

    expect(foreign).toEqual([]);
  });
});
