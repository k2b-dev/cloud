import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "cloud-country-map-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { CountryMap } = await import("./CountryMap");
const { LocaleProvider } = await import("../intl/locale");
const { WORLD_COUNTRY_DOTS, WORLD_COUNTRY_SHAPES } = await import("./world-countries");

const render = (props: Parameters<typeof CountryMap>[0], locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(CountryMap, props);
      },
    }),
  );

describe("CountryMap", () => {
  test("draws every code an IP lookup can return except Antarctica", () => {
    const drawn = new Set([...WORLD_COUNTRY_SHAPES.map(([code]) => code), ...WORLD_COUNTRY_DOTS.map(([code]) => code)]);
    const lookupCodes =
      "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW".split(
        " ",
      );
    expect(lookupCodes.filter((code) => !drawn.has(code))).toEqual(["AQ"]);
  });

  test("ranks countries by value, shades them and names the total", () => {
    const html = render({
      label: "Visitors",
      limit: 2,
      data: [
        { code: "FR", value: 100 },
        { code: "de", value: 400 },
        { code: "SG", value: 25 },
      ],
    });
    expect(html).toContain('aria-label="Visitors"');
    expect(html).toContain("Total: 525");
    expect(html.indexOf("Germany")).toBeLessThan(html.indexOf("France"));
    expect(html).toContain("+1 more");
    expect(html).toMatch(/data-country="DE"[^>]*style="fill:color-mix\(in srgb, var\(--stdlib-chart-c1\) 100%/);
    expect(html).toMatch(/<circle[^>]*data-country="SG"/);
    expect(html).not.toMatch(/<circle[^>]*data-country="MT"/);
  });

  test("localizes country names and drops values that cannot be drawn", () => {
    const html = render(
      {
        label: "Besuche",
        data: [
          { code: "DE", value: 3 },
          { code: "not-a-code", value: 9 },
          { code: "FR", value: 0 },
          { code: "IT", value: Number.NaN },
        ],
      },
      "de",
    );
    expect(html).toContain("Deutschland");
    expect(html).toContain("Gesamt: 3");
    expect(html).not.toContain("not-a-code");
    expect(html).not.toContain("Frankreich");
    expect(html).not.toContain("Italien");
  });

  test("an empty result still draws the neutral map without a list", () => {
    const html = render({ label: "Visitors", data: [] });
    expect(html).toContain('data-country="DE"');
    expect(html).not.toContain("k2b-country-map__list");
    expect(html).not.toContain("k2b-country-map__legend");
  });
});
