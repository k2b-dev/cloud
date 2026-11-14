import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { DEFAULT_STORAGE_BUCKET_ID, StorageBucketIdSchema, type StorageBucketSummary } from "../contracts/storage-buckets";

const archive = StorageBucketIdSchema.parse("3f0c2a54-8f1e-4c3b-9a0d-6b1e2c3d4e5f");
const backup = StorageBucketIdSchema.parse("9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b");
const buckets = (archiveName = "Archiv"): StorageBucketSummary[] => [
  { id: DEFAULT_STORAGE_BUCKET_ID, name: "Default", isDefault: true, connected: true },
  { id: archive, name: archiveName, isDefault: false, connected: true },
  { id: backup, name: "Backup", isDefault: false, connected: false },
];

const mount = async (locale: string, value: string | null, list: StorageBucketSummary[]) => {
  const { LocaleProvider } = await import("@k2b/ui");
  const { StorageBucketSelect } = await import("./storage-bucket-select");
  const host = document.createElement("div");
  document.body.append(host);
  const [current, setCurrent] = createSignal(value);
  const [entries, setEntries] = createSignal(list);
  const saved: string[] = [];
  const dispose = render(
    () => (
      <LocaleProvider locale={locale}>
        <StorageBucketSelect
          aria-label="Archive bucket"
          value={current()}
          buckets={entries()}
          onValueChange={(id) => {
            saved.push(id);
            setCurrent(id);
          }}
        />
      </LocaleProvider>
    ),
    host,
  );
  return { host, saved, setEntries, dispose: () => (dispose(), host.remove()) };
};
const state = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-storage-bucket-select]")?.dataset.storageBucketSelect;

if (isServer) test.skip("requires browser conditions and solid-dom-preload", () => {});
else {
  test("shows the stored bucket by its current name, also after a rename", async () => {
    const dom = createDomTestHarness();
    try {
      const view = await mount("en", archive, buckets());
      expect(state(view.host)).toBe("connected");
      expect(view.host.textContent).toContain("Archiv");
      // The administrator renamed the bucket; the stored ID is unchanged.
      view.setEntries(buckets("Archiv 2026"));
      expect(view.host.textContent).toContain("Archiv 2026");
      expect(view.host.textContent).not.toContain("removed");
      view.dispose();
    } finally {
      dom.cleanup();
    }
  });

  test("names the default bucket in the reader's language", async () => {
    const dom = createDomTestHarness();
    try {
      const view = await mount("de", DEFAULT_STORAGE_BUCKET_ID, buckets());
      expect(view.host.textContent).toContain("Standard");
      view.dispose();
    } finally {
      dom.cleanup();
    }
  });

  test("keeps a removed bucket selected and says how to recover", async () => {
    const dom = createDomTestHarness();
    try {
      const view = await mount("de", backup, buckets());
      expect(state(view.host)).toBe("disconnected");
      expect(view.host.textContent).toContain("Backup (getrennt)");
      expect(view.host.textContent).toContain("Administration › Speicher wiederhergestellt");
      expect(view.saved).toEqual([]);
      view.dispose();
    } finally {
      dom.cleanup();
    }
  });

  test("marks an unknown ID instead of switching to another bucket", async () => {
    const dom = createDomTestHarness();
    try {
      const view = await mount("en", "00000000-0000-4000-8000-000000000000", buckets());
      expect(state(view.host)).toBe("unknown");
      expect(view.host.textContent).toContain("Unknown bucket");
      expect(view.host.textContent).toContain("This Cloud has no bucket with this ID.");
      expect(view.saved).toEqual([]);
      view.dispose();
    } finally {
      dom.cleanup();
    }
  });
}
