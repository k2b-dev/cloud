import { expect, test } from "bun:test";
import type { DropdownAction, DropdownSection } from "@k2b/ui";
import { createRoot } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { useCloudIdCopy } from "./cloud-id";

const shell = (data: Record<string, unknown> | null) => {
  document.getElementById("cloud-shell-data")?.remove();
  if (!data) return;
  const script = document.createElement("script");
  script.id = "cloud-shell-data";
  script.type = "application/json";
  script.textContent = JSON.stringify(data);
  document.body.append(script);
};

const withCloudId = async <T,>(locale: string, run: (cloudId: ReturnType<typeof useCloudIdCopy>) => T): Promise<T> => {
  const { LocaleProvider } = await import("@k2b/ui");
  const { useCloudIdCopy } = await import("./cloud-id");
  return createRoot((dispose) => {
    let result!: T;
    LocaleProvider({
      locale,
      get children() {
        result = run(useCloudIdCopy());
        return null;
      },
    });
    dispose();
    return result;
  });
};

if (isServer) test.skip("requires browser conditions and solid-dom-preload", () => {});
else {
  test("a resource's menu ends with one Copy Cloud ID section, named per target when a menu offers several", async () => {
    const dom = createDomTestHarness();
    try {
      shell({ cloudOrigin: "https://cloud.example" });
      const single = await withCloudId("de", (cloudId) => cloudId.section({ type: "notebooks.note", id: "Nte001" }));
      expect(single).toHaveLength(1);
      const [item] = (single[0] as DropdownSection).items as DropdownAction[];
      expect(item).toMatchObject({ label: "Cloud-ID kopieren", icon: "ti ti-id", immediate: true });

      const several = await withCloudId("en", (cloudId) =>
        cloudId.section({ ref: { type: "mail.message", id: "Msg001" }, label: "Copy message Cloud ID" }, null, {
          type: "mail.conversation",
          id: "Cnv001",
        }),
      );
      expect((several[0] as DropdownSection).items.map((entry) => (entry as DropdownAction).label)).toEqual([
        "Copy message Cloud ID",
        "Copy Cloud ID",
      ]);
      expect(await withCloudId("en", (cloudId) => cloudId.section(null, false))).toEqual([]);
    } finally {
      shell(null);
      dom.cleanup();
    }
  });

  test("without a configured Cloud URL the menu shows no entry and nothing is copied", async () => {
    const dom = createDomTestHarness();
    try {
      shell({});
      expect(await withCloudId("en", (cloudId) => [cloudId.available(), cloudId.section({ type: "spaces.item", id: "Itm001" })])).toEqual([
        false,
        [],
      ]);
    } finally {
      shell(null);
      dom.cleanup();
    }
  });

  test("a copy before the clipboard code loads still writes the permalink inside the click", async () => {
    const dom = createDomTestHarness();
    const written: string[] = [];
    const clipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    try {
      shell({ cloudOrigin: "https://cloud.example" });
      await withCloudId("en", (cloudId) => cloudId.copy({ type: "files.entry", id: "a b/c" }));
      expect(written).toEqual(["https://cloud.example/open/files.entry/~a%20b%2Fc"]);
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
      shell(null);
      dom.cleanup();
    }
  });
}
