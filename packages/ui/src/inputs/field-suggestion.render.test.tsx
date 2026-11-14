import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import type { FieldSuggestion } from "./field-contract";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-field-suggestion-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { LocaleProvider } = await import("../intl/locale");
const { deriveSuggestionView, SuggestionGroup } = await import("./field-suggestion");
const { TextInput } = await import("./TextInput");
const { NumberInput } = await import("./NumberInput");
const { DatePicker } = await import("./DatePicker");
const { Select } = await import("./Select");
const { Switch } = await import("./Switch");

/** Renders in German inside a SuggestionGroup, which brings the suggestion code; `bare` renders without one. */
const german = (render: () => JSX.Element, bare = false) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return bare
          ? render()
          : createComponent(SuggestionGroup, {
              onAcceptAll: () => {},
              get children() {
                return render();
              },
            });
      },
    }),
  );
type Ready<T> = Extract<FieldSuggestion<T>, { state: "ready" }>;
const ready = <T,>(value: T, extra: Partial<Ready<T>> = {}): Ready<T> => ({
  id: "re-4471:v3:field",
  state: "ready",
  value,
  confidence: "high",
  source: "Gustav",
  ...extra,
});
const attribute = (html: string, element: string, name: string) => new RegExp(`<${element}[^>]*\\s${name}="([^"]*)"`).exec(html)?.[1];

describe("deriveSuggestionView", () => {
  const same = Object.is;
  test("never lets a suggestion replace what someone entered", () => {
    const suggestion = ready("RE-2026-4471");
    expect(deriveSuggestionView(undefined, "", { blank: true, edited: false, same })).toBe("none");
    expect(deriveSuggestionView({ id: "a", state: "loading" }, "", { blank: true, edited: false, same })).toBe("loading");
    expect(deriveSuggestionView({ id: "a", state: "error" }, "", { blank: true, edited: false, same })).toBe("error");
    expect(deriveSuggestionView(suggestion, "", { blank: true, edited: false, same })).toBe("open");
    // Someone's own value, typed before or after the suggestion arrived.
    expect(deriveSuggestionView(suggestion, "RE-2026-4470", { blank: false, edited: true, same })).toBe("differs");
    // A field someone emptied on purpose stays empty.
    expect(deriveSuggestionView(suggestion, "", { blank: true, edited: true, same })).toBe("differs");
    expect(deriveSuggestionView(suggestion, "RE-2026-4471", { blank: false, edited: true, same })).toBe("matches");
    expect(deriveSuggestionView({ ...suggestion, accepted: true }, "RE-2026-4471", { blank: false, edited: false, same })).toBe("accepted");
    // Edited after accepting: the value belongs to the person again.
    expect(deriveSuggestionView({ ...suggestion, accepted: true }, "RE-2026-4472", { blank: false, edited: true, same })).toBe("differs");
  });
});

describe("@k2b/ui field suggestions on the server", () => {
  test("an open suggestion is a placeholder, never the value, and Accept names the field", () => {
    const html = german(() =>
      createComponent(TextInput, {
        id: "invoice-number",
        label: "Rechnungsnummer",
        name: "invoiceNumber",
        required: true,
        value: "",
        suggestion: ready("RE-2026-4471"),
      }),
    );
    expect(attribute(html, "input", "value")).toBe("");
    expect(attribute(html, "input", "placeholder")).toBe("RE-2026-4471");
    expect(html).toContain("k2b-ai-suggestion-field k2b-ai-suggestion-open");
    expect(html).toContain('aria-label="Vorschlag für Rechnungsnummer übernehmen"');
    expect(html).toContain(">Übernehmen<");
    // The control is described by the status line, which says the value is not taken yet.
    expect(attribute(html, "input", "aria-describedby")).toContain("invoice-number-suggestion");
    expect(html).toContain('id="invoice-number-suggestion" class="k2b-sr-only">Vorschlag von Gustav, nicht übernommen.<');
  });

  test("someone's own value stays; the suggestion only sits in the status line", () => {
    const html = german(() =>
      createComponent(NumberInput, {
        id: "gross",
        label: "Betrag brutto",
        locale: "de",
        step: 0.01,
        suffix: "€",
        value: 321.4,
        suggestion: ready(312.4),
      }),
    );
    expect(attribute(html, "input", "value")).toBe("321,40");
    expect(attribute(html, "input", "placeholder")).toBeUndefined();
    expect(html).not.toContain("k2b-ai-suggestion-open");
    expect(html).toContain("Gustav: 312,40 €");
    expect(html).toContain(">Übernehmen<");
  });

  test("an accepted value says where it came from and offers nothing", () => {
    const html = german(() =>
      createComponent(TextInput, {
        label: "Lieferant",
        value: "Antikhandel Berger GmbH",
        suggestion: ready("Antikhandel Berger GmbH", { accepted: true }),
      }),
    );
    expect(html).toContain('data-view="accepted"');
    expect(html).toContain("von Gustav");
    expect(html).not.toContain(">Übernehmen<");
    expect(html).not.toContain("k2b-ai-suggestion-open");
  });

  test("an unsure value keeps Accept and explains why", () => {
    const html = german(() =>
      createComponent(Select, {
        id: "vat",
        label: "Umsatzsteuer",
        value: null,
        options: [
          { value: "19", label: "19 %" },
          { value: "7", label: "7 %" },
        ],
        suggestion: ready("19", { confidence: "low", reason: "Die Rechnung weist keine Umsatzsteuer aus." }),
      }),
    );
    expect(html).toContain("k2b-ai-suggestion-open k2b-ai-suggestion-unsure");
    expect(html).toContain(">unsicher<");
    expect(html).toContain(">19 %<");
    expect(html).toContain("Vorschlag von Gustav: 19 %, nicht übernommen. Unsicher: Die Rechnung weist keine Umsatzsteuer aus.");
    expect(html).toContain(">Übernehmen<");
  });

  test("a disabled or read-only field shows the suggestion without Accept", () => {
    for (const locked of [{ disabled: true }, { readOnly: true }]) {
      const html = german(() =>
        createComponent(TextInput, { label: "Buchungstext", value: "", ...locked, suggestion: ready("Ankauf Kommode") }),
      );
      expect(attribute(html, "input", "placeholder")).toBe("Ankauf Kommode");
      expect(html).toContain(">Vorschlag<");
      expect(html).not.toContain(">Übernehmen<");
    }
  });

  test("loading and failure keep the same line; a failure offers Retry when the owner can retry", () => {
    const loading = german(() =>
      createComponent(TextInput, { label: "Rechnungsnummer", value: "", suggestion: { id: "a", state: "loading", source: "Gustav" } }),
    );
    expect(loading).toContain("k2b-ai-suggestion-loading");
    expect(loading).toContain("Gustav liest …");
    const failed = german(() =>
      createComponent(TextInput, { label: "Rechnungsnummer", value: "", suggestion: { id: "a", state: "error", onRetry: () => {} } }),
    );
    expect(failed).toContain("kein Vorschlag");
    expect(failed).toContain(">Erneut<");
  });

  test("a field that takes suggestions reserves its status line before any suggestion exists", () => {
    const reserved = german(() => createComponent(TextInput, { label: "Rechnungsnummer", value: "", suggestion: () => undefined }));
    expect(reserved).toContain("k2b-ai-suggestion-field");
    expect(reserved).toContain('class="k2b-field__label-row"');
    expect(reserved).toContain('class="k2b-ai-suggestion" data-view="none"');
    const plain = german(() => createComponent(TextInput, { label: "Rechnungsnummer", value: "" }), true);
    expect(plain).not.toContain("k2b-ai-suggestion");
    expect(plain).not.toContain("k2b-field__label-row");
  });

  test("a value the field would not take as it is offers no Accept, also not under Accept all", () => {
    const html = german(() => [
      createComponent(DatePicker, { label: "Rechnungsdatum", value: null, min: "2026-11-01", suggestion: ready("2026-10-28") }),
      createComponent(Select, {
        label: "Buchungskonto",
        value: null,
        options: [{ value: "1800", label: "1800 Gesperrt", disabled: true }],
        suggestion: ready("1800"),
      }),
      createComponent(NumberInput, { label: "Menge", step: 5, value: null, suggestion: ready(12) }),
    ]);
    expect(html).not.toContain(">Übernehmen<");
    expect(html).toContain("Alle übernehmen (0)");
  });

  test("an accepted option from a remote list keeps the suggestion's name, however it was accepted", () => {
    const html = german(() =>
      createComponent(Select, {
        label: "Lieferant",
        value: "supplier-881",
        loadOptions: async () => [],
        suggestion: ready("supplier-881", { label: "Antikhandel Berger GmbH", accepted: true }),
      }),
    );
    expect(html).toContain(">Antikhandel Berger GmbH<");
  });

  test("a switch without a visible label reserves its status line under the switch", () => {
    const html = german(() => createComponent(Switch, { "aria-label": "Vorsteuer abziehen", value: false, suggestion: () => undefined }));
    expect(html).toMatch(
      /<div class="k2b-ai-suggestion-field__control"><div class="k2b-ai-suggestion-switch">.*<span class="k2b-ai-suggestion" data-view="none">/,
    );
  });

  test("outside a group a suggestion is ignored, and the field renders as without one", () => {
    const html = german(
      () => createComponent(TextInput, { id: "n", label: "Rechnungsnummer", value: "", suggestion: ready("RE-2026-4471") }),
      true,
    );
    expect(html).toBe(german(() => createComponent(TextInput, { id: "n", label: "Rechnungsnummer", value: "" }), true));
  });

  test("a field without a visible label shows the status under the control", () => {
    const html = german(() =>
      createComponent(TextInput, { "aria-label": "Rechnungsnummer", value: "", suggestion: ready("RE-2026-4471") }),
    );
    expect(html).toMatch(
      /<div class="k2b-field k2b-ai-suggestion-field k2b-ai-suggestion-open "><div class="k2b-input-shell k2b-text-input".*<\/div><span class="k2b-ai-suggestion"/,
    );
    expect(html).toContain('aria-label="Vorschlag für Rechnungsnummer übernehmen"');
  });

  test("date, select, and switch show the suggestion the way each control reads", () => {
    const date = german(() =>
      createComponent(DatePicker, { label: "Rechnungsdatum", value: null, dateConfig: { locale: "de" }, suggestion: ready("2026-10-28") }),
    );
    expect(attribute(date, "input", "placeholder")).toBe("28.10.2026");
    expect(date).toContain("k2b-ai-suggestion-open");

    const select = german(() =>
      createComponent(Select, {
        label: "Buchungskonto",
        value: null,
        options: [{ value: "3400", label: "3400 Wareneingang 19 %" }],
        suggestion: ready("3400"),
      }),
    );
    expect(select).toContain(">3400 Wareneingang 19 %<");
    expect(select).toContain('data-placeholder="true"');

    const toggle = german(() =>
      createComponent(Switch, { id: "deduct", label: "Vorsteuer abziehen", value: false, suggestion: ready(true) }),
    );
    expect(attribute(toggle, "input", "aria-checked") ?? "").not.toBe("true");
    expect(toggle).not.toMatch(/<input[^>]*\schecked/);
    expect(toggle).toContain("Vorschlag: Ja");
    expect(toggle).toContain('<label id="deduct-label" class="k2b-field__label" for="deduct">');
    expect(toggle).toContain("Vorschlag von Gustav: Ja, nicht übernommen.");
  });

  test("the group counts its fields in the first render and offers only certain open values", () => {
    const html = german(
      () =>
        createComponent(SuggestionGroup, {
          title: "Gustav hat 6 Felder aus RE-4471.pdf gelesen",
          source: "Gustav",
          onAcceptAll: () => {},
          get children() {
            return [
              createComponent(TextInput, {
                label: "Lieferant",
                value: "Berger",
                suggestion: { ...ready("Berger"), accepted: true, source: undefined },
              }),
              createComponent(TextInput, {
                label: "Rechnungsnummer",
                value: "",
                suggestion: { ...ready("RE-2026-4471"), source: undefined },
              }),
              createComponent(NumberInput, { label: "Betrag brutto", value: 321.4, suggestion: { ...ready(312.4), source: undefined } }),
              createComponent(Select, {
                label: "Umsatzsteuer",
                value: null,
                options: ["19 %"],
                suggestion: { ...ready("19 %"), confidence: "low" as const, source: undefined },
              }),
              createComponent(TextInput, {
                label: "Buchungstext",
                value: "",
                disabled: true,
                suggestion: { ...ready("Ankauf"), source: undefined },
              }),
              createComponent(Switch, { label: "Vorsteuer abziehen", value: false, suggestion: { ...ready(true), source: undefined } }),
            ];
          },
        }),
      true,
    );
    expect(html).toContain("1 übernommen · 3 offen · 1 unsicher");
    // Disabled, unsure, and overruled fields stay out of Accept all.
    expect(html).toContain("Alle übernehmen (2)");
    // Fields without their own source take the group's.
    expect(html).toContain("von Gustav");
    expect(html).toContain('role="group"');
  });
});
