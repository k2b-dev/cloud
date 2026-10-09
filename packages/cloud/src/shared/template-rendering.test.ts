import { describe, expect, test } from "bun:test";
import type { SettingDef } from "../services/settings/defaults";
import { SETTINGS, validateSettingValue } from "../services/settings/defaults";
import {
  escapeTemplateOutput,
  LiquidTemplateError,
  liquidTemplateVariables,
  migrateLegacyMustacheTemplate,
  renderLiquidTemplate,
  validateLiquidTemplate,
} from "./template-rendering";

const sampleValueFor = (name: string): string =>
  (
    ({
      ACCOUNT_KIND: "local",
      APP_NAME: "Cloud <Test>",
      CONTACT_EMAIL: "support@example.test",
      DISPLAY_NAME: "Ada Lovelace",
      EMAIL: "ada@example.test",
      EXPIRY: "2026-12-31",
      EXTEND_URL: "https://cloud.example.test/account/extend?x=1&y=2",
      FIRST_NAME: "Ada",
      LOGIN_URL: "https://cloud.example.test/auth/login?x=1&y=2",
      MAGIC_LINK: "https://cloud.example.test/auth/magic?token=abc&next=/app",
      PASSWORD: "Temp<Pass>&123",
      REASON: "Missing approval <pending>",
      RESET_LINK: "https://cloud.example.test/auth/reset?token=abc&next=/app",
      TOKEN: "123456",
      USERNAME: "ada",
    }) as Record<string, string>
  )[name] ?? `${name}_VALUE`;

const sampleDataFor = (variables: readonly string[], emptyOptional = false): Record<string, string> =>
  Object.fromEntries(
    variables.map((name) => [name, emptyOptional && ["CONTACT_EMAIL", "EXPIRY"].includes(name) ? "" : sampleValueFor(name)]),
  );

const isTemplateSetting = (setting: SettingDef): setting is SettingDef & { kind: "template"; default: string; templateVars?: string[] } =>
  setting.kind === "template";

describe("Liquid template rendering", () => {
  for (const body of ["", "{% assign x = c %}"]) {
    test(`bounds nested loops with ${body ? "an assignment" : "an empty body"}`, () => {
      const start = performance.now();
      expect(() =>
        renderLiquidTemplate(
          `{% for a in (1..1000) %}{% for b in (1..1000) %}{% for c in (1..1000) %}${body}{% endfor %}{% endfor %}{% endfor %}`,
          {},
          { renderTimeoutMs: 50 },
        ),
      ).toThrow(expect.objectContaining({ reason: "render_timeout" }));
      expect(performance.now() - start).toBeLessThan(3_000);
    });
  }

  for (const capture of [false, true]) {
    test(`stops oversized ${capture ? "captured" : "direct"} output during rendering`, () => {
      let calls = 0;
      const loop = "{% for i in (1..10000) %}{{ chunk | count }}{% endfor %}";
      expect(() =>
        renderLiquidTemplate(
          capture ? `{% capture result %}${loop}{% endcapture %}{{ result | truncate: 10 }}` : loop,
          { chunk: "é".repeat(50) },
          {
            renderMaxBytes: 250,
            filters: {
              count: (value: unknown) => {
                calls++;
                return value;
              },
            },
          },
        ),
      ).toThrow(expect.objectContaining({ reason: "render_too_large" }));
      expect(calls).toBe(capture ? 3_001 : 3);
    });
  }

  test("allows a capture up to the larger of the final cap and 300,000 bytes", () => {
    const template = "{% capture result %}{{ value }}{% endcapture %}{{ result | truncate: 10 }}";
    expect(renderLiquidTemplate(template, { value: "x".repeat(1_200) }, { renderMaxBytes: 10 })).toBe("xxxxxxx...");
    expect(renderLiquidTemplate(template, { value: "x".repeat(300_001) }, { renderMaxBytes: 400_000 })).toBe("xxxxxxx...");
  });

  test("renders many small writes at the default byte cap within the default time budget", () => {
    expect(
      renderLiquidTemplate("{% for row in rows %}{{ chunk }}{% endfor %}", {
        rows: Array.from({ length: 30_000 }, (_, i) => i),
        chunk: "0123456789",
      }),
    ).toHaveLength(300_000);
  });

  for (const expression of ["r contains 0", "r | sum"]) {
    test(`checks time inside expression ${expression}`, () => {
      const start = performance.now();
      expect(() =>
        renderLiquidTemplate(`{% assign r = (1..20000) %}{{ r | where_exp: 'i', '${expression}' | size }}`, {}, { renderTimeoutMs: 50 }),
      ).toThrow(expect.objectContaining({ reason: "render_timeout" }));
      expect(performance.now() - start).toBeLessThan(1_000);
    });
  }

  const largeString = "{% assign text = 'x' %}{% for i in (1..18) %}{% assign text = text | append: text %}{% endfor %}";
  for (const filter of ["push", "unshift", "concat"]) {
    test(`charges duplicated text added by ${filter} before output expansion`, () => {
      const item = filter === "concat" ? "item" : "text";
      const template = `${largeString}{% assign arr = '' | split: ',' %}{% assign item = arr | push: text %}{% for i in (1..100) %}{% assign arr = arr | ${filter}: ${item} %}{% endfor %}{{ arr }}`;
      expect(() => renderLiquidTemplate(template, {})).toThrow(expect.objectContaining({ reason: "render_memory_limit" }));
    });
  }

  test("charges text in nested duplicated arrays", () => {
    const template = `${largeString}{% assign arr = '' | split: ',' %}{% for i in (1..4) %}{% assign arr = arr | push: text %}{% endfor %}{% assign arr2 = '' | split: ',' %}{% for i in (1..6) %}{% assign arr2 = arr2 | push: arr %}{% endfor %}{{ arr2 | upcase }}`;
    expect(() => renderLiquidTemplate(template, {})).toThrow(expect.objectContaining({ reason: "render_memory_limit" }));
  });

  test("charges mapped text from duplicated object references", () => {
    expect(() =>
      renderLiquidTemplate(
        "{% assign docs = '' | split: ',' %}{% for i in (1..1000) %}{% assign docs = docs | push: doc %}{% endfor %}{{ docs | map: 'body' }}",
        { doc: { body: "x".repeat(10_000) } },
      ),
    ).toThrow(expect.objectContaining({ reason: "render_memory_limit" }));
  });

  test("allows ordinary lists without charging their left side's text again", () => {
    const names = Array.from({ length: 1_000 }, (_, i) => `Name${i}`);
    expect(
      renderLiquidTemplate(
        "{% assign names = '' | split: ',' %}{% for item in items %}{% assign names = names | push: item.name %}{% endfor %}{{ names | join: ', ' }}",
        { items: names.map((name) => ({ name })) },
      ),
    ).toBe(names.join(", "));
    expect(renderLiquidTemplate("{{ items | map: 'name' | join: ', ' }}", { items: names.map((name) => ({ name })) })).toBe(
      names.join(", "),
    );
  });

  test("preserves raw filter output", () => {
    expect(renderLiquidTemplate("{{ value | raw }}", { value: "<b>Ada</b>" })).toBe("<b>Ada</b>");
  });

  test("allows exactly-at-limit UTF-8 output, including captures", () => {
    expect(renderLiquidTemplate("a{{ value }}", { value: "é😀" }, { renderMaxBytes: 7 })).toBe("aé😀");
    expect(renderLiquidTemplate("{% capture result %}é😀{% endcapture %}{{ result }}", {}, { renderMaxBytes: 6 })).toBe("é😀");
    expect(() => renderLiquidTemplate("{{ value }}", { value: "é😀" }, { renderMaxBytes: 5 })).toThrow(
      expect.objectContaining({ reason: "render_too_large" }),
    );
  });

  test("counts surrogate pairs split across writes as UTF-8", () => {
    expect(renderLiquidTemplate("{{ high }}{{ low }}", { high: "\ud83d", low: "\ude00" }, { renderMaxBytes: 4, escapeOutput: false })).toBe(
      "😀",
    );
  });

  test("checks the time budget after a final filter", () => {
    expect(() =>
      renderLiquidTemplate(
        "{{ value | slow }}",
        { value: "ok" },
        {
          renderTimeoutMs: 5,
          filters: {
            slow: (value: unknown) => {
              const start = performance.now();
              while (performance.now() - start < 10) {
                /* Simulate a synchronous filter. */
              }
              return value;
            },
          },
        },
      ),
    ).toThrow(expect.objectContaining({ reason: "render_timeout" }));
  });

  test("uses the default output cap and resets budgets for each render", () => {
    expect(() => renderLiquidTemplate("{{ value }}", { value: "x".repeat(300_001) })).toThrow(
      expect.objectContaining({ reason: "render_too_large" }),
    );
    for (let i = 0; i < 2; i++) {
      expect(renderLiquidTemplate("{{ value }}", { value: "x".repeat(300_000) })).toHaveLength(300_000);
    }
  });

  test("reports the memory limit before allocating a large range", () => {
    expect(() => renderLiquidTemplate("{% for i in (1..1000000000) %}{% endfor %}", {})).toThrow(
      expect.objectContaining({ reason: "render_memory_limit" }),
    );
  });

  test("preserves ordinary render errors", () => {
    try {
      renderLiquidTemplate("{{ missing }}", {});
      throw new Error("Expected undefined variable error");
    } catch (error) {
      expect(error).not.toBeInstanceOf(LiquidTemplateError);
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) expect(error.message).toContain("undefined variable: missing");
    }
  });

  test("uses legacy-compatible HTML escaping", () => {
    expect(escapeTemplateOutput(`&\\<>"'\`=/`)).toBe("&amp;\\&lt;&gt;&quot;&#39;&#x60;&#x3D;&#x2F;");
    expect(renderLiquidTemplate(`<a href="{{ URL }}">{{ LABEL }}</a>`, { URL: "https://x.test/a?b=1&c=2", LABEL: "<Hi>" })).toBe(
      `<a href="https:&#x2F;&#x2F;x.test&#x2F;a?b&#x3D;1&amp;c&#x3D;2">&lt;Hi&gt;</a>`,
    );
  });

  test("migrates legacy Mustache sections to Liquid blank checks", () => {
    expect(migrateLegacyMustacheTemplate("{{#CONTACT_EMAIL}}mail{{/CONTACT_EMAIL}}{{^EXPIRY}}none{{/EXPIRY}}")).toBe(
      "{% if CONTACT_EMAIL != blank %}mail{% endif %}{% if EXPIRY == blank %}none{% endif %}",
    );
  });

  test("supports per-render custom filters without registering them globally", () => {
    const template = `<p>{{ LABEL | suffix: "!" }}</p>`;
    const filters = { suffix: (value: unknown, suffix: unknown) => `${value}${suffix}` };

    expect(validateLiquidTemplate(template, { filters })).toEqual({ ok: true });
    expect(renderLiquidTemplate(template, { LABEL: "Ada" }, { filters })).toBe("<p>Ada!</p>");
    expect(() => renderLiquidTemplate(template, { LABEL: "Ada" })).toThrow();
  });

  test("supports context-specific escaping and static variable inspection", () => {
    const template = "{{ user.name }} / {{ item | suffix: '!' }}";
    const filters = { suffix: (value: unknown, suffix: unknown) => `${value}${suffix}` };

    expect(liquidTemplateVariables(template, { filters })).toEqual(["user.name", "item"]);
    expect(
      renderLiquidTemplate(template, { user: { name: "*Ada*" }, item: "_mail_" }, { filters, escapeOutput: (value) => `[${value}]` }),
    ).toBe("[*Ada*] / [_mail_!]");
  });

  test("normalizes legacy template settings on validation", () => {
    const def = SETTINGS.find((setting) => setting.key === "mail.password_reset");
    expect(def).toBeDefined();
    const result = validateSettingValue(def!, "{{#CONTACT_EMAIL}}Hi {{CONTACT_EMAIL}}{{/CONTACT_EMAIL}}");
    expect(result).toEqual({ ok: true, value: "{% if CONTACT_EMAIL != blank %}Hi {{CONTACT_EMAIL}}{% endif %}" });
  });

  test("all default template settings are valid Liquid", () => {
    const templates = SETTINGS.filter(isTemplateSetting);
    expect(templates.length).toBeGreaterThan(0);

    for (const setting of templates) {
      expect(setting.default).not.toContain("{{#");
      expect(setting.default).not.toContain("{{^");
      expect(validateLiquidTemplate(setting.default)).toEqual({ ok: true });
      expect(() => renderLiquidTemplate(setting.default, sampleDataFor(setting.templateVars ?? []))).not.toThrow();
      expect(() => renderLiquidTemplate(setting.default, sampleDataFor(setting.templateVars ?? [], true))).not.toThrow();
    }
  });
});
