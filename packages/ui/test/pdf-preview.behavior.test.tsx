import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

const domTest = isServer ? test.skip : test;
const click = (button: HTMLButtonElement) => {
  const event = new MouseEvent("click", { bubbles: true });
  Object.defineProperty(event, "currentTarget", { value: button });
  const handler = (button as HTMLButtonElement & { $$click?: (event: MouseEvent) => void }).$$click;
  if (handler) handler(event);
  else button.click();
};

for (const autoLoad of [false, true]) {
  domTest(`PDF preview autoLoad=${autoLoad} respects opt-in and cleans up late results`, async () => {
    const dom = createDomTestHarness();
    const { default: PdfPreview } = await import("../src/content/PdfPreview");
    let calls = 0;
    let resolvePdf!: (blob: Blob) => void;
    const pending = new Promise<Blob>((resolve) => {
      resolvePdf = resolve;
    });
    const created: string[] = [];
    const revoked: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => {
      created.push("blob:preview");
      return "blob:preview";
    };
    URL.revokeObjectURL = (url) => {
      revoked.push(url);
    };
    const dispose = render(
      () => (
        <PdfPreview
          autoLoad={autoLoad}
          request={() => {
            calls++;
            return pending;
          }}
        />
      ),
      dom.root,
    );
    try {
      expect(calls).toBe(autoLoad ? 1 : 0);
      if (!autoLoad) click(dom.root.querySelector<HTMLButtonElement>(".k2b-content-pdf-preview__actions button:last-child")!);
      expect(calls).toBe(1);
      expect(dom.root.querySelector('[role="status"]')?.textContent).toBe("Loading...");
      expect(dom.root.querySelector<HTMLButtonElement>(".k2b-content-pdf-preview__actions button:last-child")!.disabled).toBe(true);
      dispose();
      resolvePdf(new Blob(["pdf"], { type: "application/pdf" }));
      await Bun.sleep(0);
      expect(created).toEqual(["blob:preview"]);
      expect(revoked).toEqual(created);
    } finally {
      dispose();
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      dom.cleanup();
    }
  });
}

domTest("disabled automatic previews do not issue a request", async () => {
  const dom = createDomTestHarness();
  const { default: PdfPreview } = await import("../src/content/PdfPreview");
  let calls = 0;
  const dispose = render(
    () => (
      <PdfPreview
        autoLoad
        disabled={() => true}
        request={async () => {
          calls++;
          return new Blob();
        }}
      />
    ),
    dom.root,
  );
  try {
    await Bun.sleep(0);
    expect(calls).toBe(0);
  } finally {
    dispose();
    dom.cleanup();
  }
});

domTest("automatic preview failures stay visible and retry only after an explicit action", async () => {
  const dom = createDomTestHarness();
  const { default: PdfPreview } = await import("../src/content/PdfPreview");
  let calls = 0;
  const dispose = render(
    () => (
      <PdfPreview
        autoLoad
        request={async () => {
          calls++;
          throw new Error("Renderer unavailable");
        }}
      />
    ),
    dom.root,
  );
  try {
    await Bun.sleep(0);
    expect(calls).toBe(1);
    expect(dom.root.textContent).toContain("Renderer unavailable");
    const retry = dom.root.querySelector<HTMLButtonElement>(".k2b-content-pdf-preview__actions button:last-child")!;
    expect(retry.disabled).toBe(false);
    click(retry);
    await Bun.sleep(0);
    expect(calls).toBe(2);
  } finally {
    dispose();
    dom.cleanup();
  }
});

domTest("composed preview keeps controls in the caller's header and exposes a failed reload instead of stale content", async () => {
  const dom = createDomTestHarness();
  const { default: PdfPreview } = await import("../src/content/PdfPreview");
  let calls = 0;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  URL.createObjectURL = () => "blob:composed-preview";
  URL.revokeObjectURL = (url) => revoked.push(url);
  const dispose = render(
    () => (
      <PdfPreview
        autoLoad
        title="Invoice preview"
        request={async () => {
          if (++calls > 1) return Response.json({ message: "Due date is missing" }, { status: 400 });
          return new Blob(["pdf"], { type: "application/pdf" });
        }}
        renderError={(message) => <aside role="alert">Check your draft: {message}</aside>}
      >
        {(preview) => (
          <main>
            <header>{preview.actions}</header>
            <article>{preview.content}</article>
          </main>
        )}
      </PdfPreview>
    ),
    dom.root,
  );
  try {
    await Bun.sleep(0);
    expect(dom.root.querySelector(".k2b-content-pdf-preview")).toBeNull();
    expect(dom.root.querySelectorAll("header button")).toHaveLength(2);
    expect(dom.root.querySelector("iframe")?.title).toBe("Invoice preview");
    click(dom.root.querySelector<HTMLButtonElement>("header button:last-child")!);
    await Bun.sleep(0);
    expect(dom.root.querySelector("iframe")).toBeNull();
    expect(dom.root.querySelector('[role="alert"]')?.textContent).toBe("Check your draft: Due date is missing");
    expect(dom.root.querySelector(".k2b-content-pdf-preview__empty")).toBeNull();
    dispose();
    expect(revoked).toEqual(["blob:composed-preview"]);
  } finally {
    dispose();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    dom.cleanup();
  }
});
