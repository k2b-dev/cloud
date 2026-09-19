import { describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";
import { relativeDateCases } from "./relative-date-cases";

describe("Format.RelativeDate browser parity", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("matches the SSR calendar cases without a browser locale or timezone assumption", async () => {
    const dom = createDomTestHarness();
    document.documentElement.lang = "en";
    const { Format } = await import("../src/intl");
    const dispose = render(
      () => (
        <>
          {relativeDateCases.map(({ expected, ...props }) => (
            <Format.RelativeDate {...props} />
          ))}
        </>
      ),
      dom.root,
    );
    const rendered = Array.from(dom.root.querySelectorAll("time"));
    expect(rendered.map((element) => element.textContent)).toEqual(relativeDateCases.map((item) => item.expected));
    expect(rendered.map((element) => element.dateTime)).toEqual(relativeDateCases.map((item) => item.value));
    dispose();
    dom.cleanup();
  });

  test("updates at caller-owned midnight rollover and reacts to invalid dates", async () => {
    const dom = createDomTestHarness();
    document.documentElement.lang = "de";
    const { Format } = await import("../src/intl");
    const [base, setBase] = createSignal("2026-09-17T21:59:00Z");
    const [value, setValue] = createSignal("2026-09-18");
    const dispose = render(
      () => <Format.RelativeDate value={value()} base={base()} timeZone="Europe/Berlin" fallback="Unbekannt" />,
      dom.root,
    );
    expect(dom.root.textContent).toBe("morgen");
    setBase("2026-09-17T22:00:00Z");
    expect(dom.root.textContent).toBe("heute");
    setValue("invalid");
    expect(dom.root.querySelector("time")).toBeNull();
    expect(dom.root.querySelector("span")?.textContent).toBe("Unbekannt");
    dispose();
    dom.cleanup();
  });
});
