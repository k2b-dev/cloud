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
    click(dom.root.querySelector<HTMLButtonElement>("header button:last-child")!);
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

const stubPdfBrowser = (dom: ReturnType<typeof createDomTestHarness>) => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const objectUrls = new Map<string, Blob>();
  const tab = { opener: {} as unknown, document: { title: "", body: { textContent: "" } }, location: { href: "" }, close() {} };
  URL.createObjectURL = (blob) => {
    const url = `blob:document-${objectUrls.size + 1}`;
    objectUrls.set(url, blob as Blob);
    return url;
  };
  URL.revokeObjectURL = () => {};
  dom.window.open = (() => tab) as unknown as typeof dom.window.open;
  return {
    objectUrls,
    tab,
    restore: () => {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    },
  };
};
const labels = (root: HTMLElement) => Array.from(root.querySelectorAll("button"), (button) => button.textContent?.trim());

domTest("an automatic preview opens the shown document in a new tab and offers the host's download", async () => {
  const dom = createDomTestHarness();
  const browser = stubPdfBrowser(dom);
  const { default: PdfPreview } = await import("../src/content/PdfPreview");
  const pdf = new Blob(["%PDF-1.4"], { type: "application/pdf" });
  let calls = 0;
  let downloads = 0;
  const dispose = render(
    () => (
      <PdfPreview
        autoLoad
        title="Report.pdf"
        openButtonLabel="Open in new tab"
        onDownload={() => downloads++}
        request={async () => {
          calls++;
          return pdf;
        }}
      />
    ),
    dom.root,
  );
  try {
    expect(labels(dom.root)).toEqual(["Open in new tab", "Download"]);
    await Bun.sleep(0);
    // Rendering again would show the same document, so only open and download remain.
    expect(labels(dom.root)).toEqual(["Open in new tab", "Download"]);
    const [open, download] = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button"));
    click(download!);
    expect(downloads).toBe(1);
    click(open!);
    await Bun.sleep(0);
    expect(calls).toBe(1);
    expect(browser.tab.opener).toBeNull();
    expect(browser.objectUrls.get(browser.tab.location.href)).toBe(pdf);
    expect(browser.tab.location.href).not.toBe(dom.root.querySelector("iframe")?.getAttribute("src"));
  } finally {
    dispose();
    browser.restore();
    dom.cleanup();
  }
});

domTest("an on-demand preview keeps rendering and opens the current document for editable input", async () => {
  const dom = createDomTestHarness();
  const browser = stubPdfBrowser(dom);
  const { default: PdfPreview } = await import("../src/content/PdfPreview");
  const versions: Blob[] = [];
  const dispose = render(
    () => (
      <PdfPreview
        request={async () => {
          const pdf = new Blob([`%PDF version ${versions.length + 1}`], { type: "application/pdf" });
          versions.push(pdf);
          return pdf;
        }}
      />
    ),
    dom.root,
  );
  try {
    const [open, renderPreview] = Array.from(dom.root.querySelectorAll<HTMLButtonElement>(".k2b-content-pdf-preview__actions button"));
    click(renderPreview!);
    await Bun.sleep(0);
    expect(labels(dom.root)).toEqual(["Open preview", "Preview PDF"]);
    click(open!);
    await Bun.sleep(0);
    expect(versions).toHaveLength(2);
    expect(browser.objectUrls.get(browser.tab.location.href)).toBe(versions[1]);
  } finally {
    dispose();
    browser.restore();
    dom.cleanup();
  }
});

domTest("an automatic preview keeps its retry in place while it loads and then moves focus to the open action", async () => {
  const dom = createDomTestHarness();
  const browser = stubPdfBrowser(dom);
  const { default: PdfPreview } = await import("../src/content/PdfPreview");
  let calls = 0;
  let resolveRetry!: (blob: Blob) => void;
  const dispose = render(
    () => (
      <PdfPreview
        autoLoad
        openButtonLabel="Open in new tab"
        buttonLabel="Try again"
        request={() => {
          if (++calls === 1) return Promise.reject(new Error("Network error"));
          return new Promise<Blob>((resolve) => {
            resolveRetry = resolve;
          });
        }}
      />
    ),
    dom.root,
  );
  try {
    await Bun.sleep(0);
    expect(dom.root.querySelector('[role="alert"]')?.textContent).toBe("Network error");
    const [open, retry] = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button"));
    expect(labels(dom.root)).toEqual(["Open in new tab", "Try again"]);
    retry!.focus();
    click(retry!);
    // The activated control stays where it is and shows that it is busy.
    expect(retry!.isConnected).toBe(true);
    expect(retry!.disabled).toBe(true);
    expect(dom.root.querySelector('[role="status"]')?.textContent).toBe("Loading...");
    resolveRetry(new Blob(["%PDF-1.4"], { type: "application/pdf" }));
    await Bun.sleep(0);
    expect(calls).toBe(2);
    expect(dom.root.querySelector("iframe")).not.toBeNull();
    // The shown document makes the retry redundant; keyboard focus continues on the open action.
    expect(labels(dom.root)).toEqual(["Open in new tab"]);
    expect(dom.document.activeElement).toBe(open!);
  } finally {
    dispose();
    browser.restore();
    dom.cleanup();
  }
});

domTest("a blocked tab keeps the shown document and says so in the inherited locale", async () => {
  const dom = createDomTestHarness();
  dom.document.documentElement.lang = "de";
  const browser = stubPdfBrowser(dom);
  let blocked = true;
  dom.window.open = (() => (blocked ? null : browser.tab)) as unknown as typeof dom.window.open;
  const { default: PdfPreview } = await import("../src/content/PdfPreview");
  const pdf = new Blob(["%PDF-1.4"], { type: "application/pdf" });
  let calls = 0;
  const dispose = render(
    () => (
      <PdfPreview
        autoLoad
        request={async () => {
          calls++;
          return pdf;
        }}
      />
    ),
    dom.root,
  );
  try {
    await Bun.sleep(0);
    const frame = dom.root.querySelector("iframe");
    expect(frame).not.toBeNull();
    const open = dom.root.querySelector<HTMLButtonElement>("button")!;
    click(open);
    await Bun.sleep(0);
    expect(dom.root.querySelector("iframe")).toBe(frame);
    expect(dom.root.querySelector('[role="alert"]')?.textContent).toBe(
      "Der Browser hat den neuen Tab blockiert. Erlaube Pop-ups und versuche es erneut.",
    );
    // Showing the same stored document again is not a way out of a blocked tab.
    expect(labels(dom.root)).toEqual(["Vorschau öffnen"]);
    blocked = false;
    click(open);
    await Bun.sleep(0);
    expect(dom.root.querySelector('[role="alert"]')).toBeNull();
    expect(browser.objectUrls.get(browser.tab.location.href)).toBe(pdf);
    expect(calls).toBe(1);
  } finally {
    dispose();
    browser.restore();
    dom.cleanup();
  }
});
