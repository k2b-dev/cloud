import { describe, expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import type { GeoAddress } from "../contracts/geo";

const provenance = {
  provider: "geoapify" as const,
  attribution: {
    text: "Geoapify · OpenStreetMap" as const,
    links: ["https://geoapify.com", "https://www.openstreetmap.org/copyright"],
  },
  computedAt: "2026-10-22T10:00:00.000Z",
};
const suggestion = (line1: string, postalCode: string): GeoAddress => ({
  line1,
  postalCode,
  city: "Ulm",
  stateRegion: "Baden-Württemberg",
  countryCode: "DE",
  point: { lat: 48.4, lon: 9.99 },
  formatted: `${line1}, ${postalCode} Ulm, Germany`,
  confidence: 1,
  buildingConfidence: 1,
  provenance,
});

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const installBrowserApis = (dom: DomTestHarness, phone = false) => {
  const prototype = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
  const open = new WeakSet<object>();
  const matches = prototype.matches as (this: Element, selector: string) => boolean;
  prototype.matches = function (this: Element, selector: string) {
    return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
  };
  prototype.showPopover = function (this: object) {
    open.add(this);
  };
  prototype.hidePopover = function (this: object) {
    open.delete(this);
  };
  prototype.scrollIntoView = () => {};
  const matchMedia = () => ({ matches: phone, addEventListener: () => {}, removeEventListener: () => {} });
  Object.assign(dom.window, { matchMedia });
  Object.assign(globalThis, { matchMedia });
};

type Call = { url: string; text: string; limit: number; release: (body: unknown, status?: number) => void };
const stubCapabilities = () => {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: { text: string; limit: number } };
      return await new Promise<Response>((resolve) => {
        calls.push({
          url: String(input),
          text: body.input.text,
          limit: body.input.limit,
          release: (value, status = 200) => resolve(Response.json(value, { status })),
        });
      });
    },
    { preconnect: original.preconnect },
  );
  return { calls, restore: () => (globalThis.fetch = original) };
};

const ok = (suggestions: GeoAddress[]) => ({ data: { suggestions, provenance } });

describe("AddressAutocomplete", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const setup = async (
    options: {
      phone?: boolean;
      availability?: Parameters<typeof import("./AddressAutocomplete").AddressAutocomplete>[0]["availability"];
    } = {},
  ) => {
    const dom = createDomTestHarness();
    installBrowserApis(dom, options.phone);
    const fetches = stubCapabilities();
    const { AddressAutocomplete } = await import("./AddressAutocomplete");
    const { createSignal } = await import("solid-js");
    delegateEvents(["input", "click", "keydown"]);
    const [value, setValue] = createSignal("");
    const picks: GeoAddress[] = [];
    const own: string[] = [];
    const dispose = render(
      () => (
        <AddressAutocomplete
          label="Street and number"
          value={value()}
          onValueChange={setValue}
          onPick={(address) => {
            picks.push(address);
            setValue(address.line1);
          }}
          onOwnEntry={(text) => own.push(text)}
          availability={options.availability}
        />
      ),
      dom.root,
    );
    const input = () => dom.root.querySelector<HTMLInputElement>("input")!;
    const type = (text: string) => {
      const element = input();
      element.value = text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const key = (name: string) => input().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    const options_ = () => Array.from(dom.root.querySelectorAll<HTMLElement>('[role="option"]'), (option) => option.textContent ?? "");
    return {
      dom,
      fetches,
      picks,
      own,
      value,
      input,
      type,
      key,
      options: options_,
      cleanup: () => {
        dispose();
        fetches.restore();
        dom.cleanup();
      },
    };
  };

  test("waits for 3 characters and 250 ms, asks for 5, and keeps one request in flight", async () => {
    const f = await setup();
    try {
      f.type("Fr");
      await Bun.sleep(300);
      expect(f.fetches.calls).toHaveLength(0);

      f.type("Fra");
      await Bun.sleep(150);
      expect(f.fetches.calls).toHaveLength(0);
      await waitFor(() => f.fetches.calls.length === 1, "first request");
      expect(f.fetches.calls[0]).toMatchObject({ url: "/api/capabilities/v1/queries/core/address.autocomplete", text: "Fra", limit: 5 });

      // A newer query waits for the open request instead of cancelling it.
      f.type("Frauenstr");
      await Bun.sleep(400);
      expect(f.fetches.calls).toHaveLength(1);
      f.fetches.calls[0]!.release(ok([suggestion("Fraunhofer 1", "89073")]));
      await waitFor(() => f.fetches.calls.length === 2, "follow-up request");
      expect(f.fetches.calls[1]!.text).toBe("Frauenstr");
      f.fetches.calls[1]!.release(ok([suggestion("Frauenstraße 28", "89073"), suggestion("Frauenstraße 2", "89073")]));
      await waitFor(() => f.options().length === 3, "options");
      // Stale results never replace the latest query; the own entry comes last on a desktop.
      expect(f.options()[0]).toContain("Frauenstraße 28");
      expect(f.options()[2]).toContain("“Frauenstr”");
      expect(f.dom.root.textContent).toContain("Enter");
      expect(f.dom.root.textContent).toContain("OpenStreetMap");

      // The first suggestion is active: Enter takes it and the host fills the field.
      f.key("Enter");
      expect(f.picks.map((address) => [address.line1, address.point])).toEqual([["Frauenstraße 28", { lat: 48.4, lon: 9.99 }]]);
      expect(f.input().value).toBe("Frauenstraße 28");
      expect(f.input().getAttribute("aria-expanded")).toBe("false");
    } finally {
      f.cleanup();
    }
  });

  test("Escape keeps the own text; the own entry comes first on a phone", async () => {
    const f = await setup({ phone: true });
    try {
      f.type("Frauenstr 28");
      await waitFor(() => f.fetches.calls.length === 1, "request");
      f.fetches.calls[0]!.release(ok([suggestion("Frauenstraße 28", "89073")]));
      await waitFor(() => f.options().length === 2, "options");
      expect(f.options()[0]).toContain("“Frauenstr 28”");
      expect(f.dom.root.textContent).not.toContain("Enter");
      f.key("Escape");
      expect(f.input().getAttribute("aria-expanded")).toBe("false");
      expect(f.value()).toBe("Frauenstr 28");
      expect(f.picks).toHaveLength(0);

      f.type("Frauenstr 28a");
      await waitFor(() => f.fetches.calls.length === 2, "second request");
      f.fetches.calls[1]!.release(ok([suggestion("Frauenstraße 28", "89073")]));
      await waitFor(() => f.options()[0]?.includes("28a") ?? false, "own option");
      f.dom.root.querySelector<HTMLElement>('[role="option"]')!.click();
      expect(f.own).toEqual(["Frauenstr 28a"]);
      expect(f.value()).toBe("Frauenstr 28a");
    } finally {
      f.cleanup();
    }
  });

  test("an exhausted budget shows a calm line and stops asking", async () => {
    const f = await setup();
    try {
      f.type("Frauenstr");
      await waitFor(() => f.fetches.calls.length === 1, "request");
      f.fetches.calls[0]!.release(
        {
          code: "GEO_BUDGET_EXHAUSTED",
          message: "Budget exhausted",
          details: { code: "GEO_BUDGET_EXHAUSTED", scope: "person", resetsAt: "2026-10-22T22:00:00.000Z" },
        },
        429,
      );
      await waitFor(() => f.dom.root.textContent?.includes("used up for today") ?? false, "budget line");
      expect(f.options()).toHaveLength(0);
      f.type("Frauenstraße");
      await Bun.sleep(400);
      expect(f.fetches.calls).toHaveLength(1);
      expect(f.value()).toBe("Frauenstraße");
    } finally {
      f.cleanup();
    }
  });

  test("starts with the SSR budget state and never asks", async () => {
    const f = await setup({
      availability: {
        configured: true,
        person: { exhausted: false, resetsAt: "2026-10-22T22:00:00.000Z" },
        cloud: { exhausted: true, resetsAt: "2026-10-31T23:00:00.000Z" },
      },
    });
    try {
      f.type("Frauenstr");
      await Bun.sleep(400);
      expect(f.fetches.calls).toHaveLength(0);
      expect(f.dom.root.textContent).toContain("used up until");
    } finally {
      f.cleanup();
    }
  });

  test("without a configured geo service the field is a plain input", async () => {
    const f = await setup({
      availability: {
        configured: false,
        person: { exhausted: false, resetsAt: "2026-10-22T22:00:00.000Z" },
        cloud: { exhausted: false, resetsAt: "2026-10-31T23:00:00.000Z" },
      },
    });
    try {
      expect(f.dom.root.querySelector('[role="combobox"]')).toBeNull();
      f.type("Frauenstr");
      await Bun.sleep(400);
      expect(f.fetches.calls).toHaveLength(0);
      expect(f.value()).toBe("Frauenstr");
    } finally {
      f.cleanup();
    }
  });
});
