import { expect, mock, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

// pdf.js draws pages only in a real browser (pdf-viewer.browser.test.ts covers the pages and the pill). Here it always
// fails, so every shown document reaches the viewer's "cannot be shown here" state; these tests cover the states.
const opened: unknown[] = [];
mock.module("../src/content/pdf-document", () => ({
  openPdfDocument: async (data: unknown) => {
    opened.push(data);
    throw new Error("pdf.js draws only in a real browser");
  },
  pageImageWidth: () => 400,
  PDF_LIMITS: { maxBytes: 1, maxPages: 1, maxCanvasPixels: 1, maxImageWidth: 1 },
  PDF_TOO_LARGE: "PdfTooLargeError",
}));
// Loaded ahead, so the viewer's lazy pages resolve from the module cache within a few turns.
if (!isServer) {
  const dom = createDomTestHarness();
  await import("../src/content/PdfPages");
  dom.cleanup();
}

const domTest = isServer ? test.skip : test;
const settle = async () => {
  for (let turn = 0; turn < 10; turn++) await Bun.sleep(0);
};
const click = (button: HTMLButtonElement) => {
  const event = new MouseEvent("click", { bubbles: true });
  Object.defineProperty(event, "currentTarget", { value: button });
  const handler = (button as HTMLButtonElement & { $$click?: (event: MouseEvent) => void }).$$click;
  if (handler) handler(event);
  else button.click();
};
const viewer = (root: HTMLElement) => root.querySelector<HTMLElement>(".k2b-pdf-viewer")!;
const pdf = () => new Blob(["%PDF-1.7"], { type: "application/pdf" });

for (const autoLoad of [false, true]) {
  domTest(`autoLoad=${autoLoad} requests only when asked and drops an answer that arrives after the viewer is gone`, async () => {
    const dom = createDomTestHarness();
    const { default: PdfViewer } = await import("../src/content/PdfViewer");
    let calls = 0;
    let resolvePdf!: (blob: Blob) => void;
    const pending = new Promise<Blob>((resolve) => {
      resolvePdf = resolve;
    });
    opened.length = 0;
    const dispose = render(
      () => (
        <PdfViewer
          title="Report"
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
      if (!autoLoad) {
        expect(viewer(dom.root).dataset.state).toBe("idle");
        click(viewer(dom.root).querySelector("button")!);
      }
      expect(calls).toBe(1);
      expect(viewer(dom.root).dataset.state).toBe("loading");
      expect(dom.root.querySelector('[role="status"]')?.textContent).toBe("Loading...");
      dispose();
      resolvePdf(pdf());
      await settle();
      expect(opened).toEqual([]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}

domTest("a disabled request waits and starts once enabled", async () => {
  const dom = createDomTestHarness();
  const { default: PdfViewer } = await import("../src/content/PdfViewer");
  const [disabled, setDisabled] = createSignal(true);
  let calls = 0;
  const dispose = render(
    () => (
      <PdfViewer
        title="Report"
        autoLoad
        disabled={disabled()}
        request={async () => {
          calls++;
          return pdf();
        }}
      />
    ),
    dom.root,
  );
  try {
    await settle();
    expect(calls).toBe(0);
    expect(viewer(dom.root).dataset.state).toBe("idle");
    expect(viewer(dom.root).querySelector("button")).toBeNull();
    setDisabled(false);
    await settle();
    expect(calls).toBe(1);
  } finally {
    dispose();
    dom.cleanup();
  }
});

domTest("a failed request shows the server's reason with a retry in the same area", async () => {
  const dom = createDomTestHarness();
  const { default: PdfViewer } = await import("../src/content/PdfViewer");
  let calls = 0;
  const dispose = render(
    () => (
      <PdfViewer
        title="Report"
        autoLoad
        request={async () => {
          calls++;
          return calls === 1 ? Response.json({ message: "Choose a period first" }, { status: 400 }) : new Response(null, { status: 503 });
        }}
      />
    ),
    dom.root,
  );
  try {
    await settle();
    expect(viewer(dom.root).dataset.state).toBe("error");
    expect(viewer(dom.root).textContent).toContain("Choose a period first");
    const retry = viewer(dom.root).querySelector<HTMLButtonElement>("button")!;
    expect(retry.textContent).toBe("Retry");
    click(retry);
    await settle();
    expect(calls).toBe(2);
    expect(viewer(dom.root).textContent).toContain("PDF preview failed with HTTP 503");
  } finally {
    dispose();
    dom.cleanup();
  }
});

domTest("a document pdf.js cannot draw says so, announces it, and offers the open action only when given", async () => {
  const dom = createDomTestHarness();
  const { default: PdfViewer } = await import("../src/content/PdfViewer");
  const errors: unknown[] = [];
  const [open, setOpen] = createSignal(false);
  const dispose = render(() => <PdfViewer title="Report" data={pdf()} open={open()} onError={(error) => errors.push(error)} />, dom.root);
  try {
    await settle();
    expect(viewer(dom.root).dataset.state).toBe("undrawable");
    expect(viewer(dom.root).textContent).toContain("This PDF cannot be shown here");
    expect(errors).toHaveLength(1);
    expect(dom.root.querySelector("iframe")).toBeNull();
    expect(viewer(dom.root).querySelector("button")).toBeNull();
    setOpen(true);
    expect(viewer(dom.root).querySelector("button")?.textContent).toBe("Open in new tab");
  } finally {
    dispose();
    dom.cleanup();
  }
});

domTest("open shows the document in a new tab, or the given address, and says when the browser blocks the tab", async () => {
  const dom = createDomTestHarness();
  const { default: PdfViewer } = await import("../src/content/PdfViewer");
  const originalOpen = window.open;
  const originalCreate = URL.createObjectURL;
  const tabs: { url: string | URL | undefined; tab: { opener: unknown; location: { href: string }; document: Document } | null }[] = [];
  let block = false;
  window.open = ((url?: string | URL) => {
    const tab = block ? null : { opener: window, location: { href: "" }, document: document.implementation.createHTMLDocument("") };
    tabs.push({ url, tab });
    return tab as unknown as Window;
  }) as typeof window.open;
  URL.createObjectURL = () => "blob:shown";
  const [address, setAddress] = createSignal<string | true>(true);
  const dispose = render(() => <PdfViewer title="Report" data={pdf()} open={address()} />, dom.root);
  try {
    await settle();
    click(viewer(dom.root).querySelector("button")!);
    expect(tabs[0]?.url).toBe("");
    expect(tabs[0]?.tab?.opener).toBeNull();
    expect(tabs[0]?.tab?.location.href).toBe("blob:shown");
    setAddress("/files/report.pdf");
    click(viewer(dom.root).querySelector("button")!);
    expect(tabs[1]?.url).toBe("/files/report.pdf");
    expect(tabs[1]?.tab?.opener).toBeNull();
    block = true;
    click(viewer(dom.root).querySelector("button")!);
    expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain("The browser blocked the new tab");
  } finally {
    window.open = originalOpen;
    URL.createObjectURL = originalCreate;
    dispose();
    dom.cleanup();
  }
});

domTest("an address loads from this site and a new address stops the previous request", async () => {
  const dom = createDomTestHarness();
  const { default: PdfViewer } = await import("../src/content/PdfViewer");
  const originalFetch = globalThis.fetch;
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Promise<Response>(() => {});
    },
    { preconnect: originalFetch.preconnect },
  );
  const [href, setHref] = createSignal("/files/a.pdf");
  const dispose = render(() => <PdfViewer title="Report" data={href()} />, dom.root);
  try {
    await settle();
    expect(requests.map((request) => [request.url, request.init?.credentials])).toEqual([["/files/a.pdf", "same-origin"]]);
    setHref("/files/b.pdf");
    await settle();
    expect(requests[1]?.url).toBe("/files/b.pdf");
    expect(requests[0]?.init?.signal?.aborted).toBe(true);
    dispose();
    expect(requests[1]?.init?.signal?.aborted).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    dispose();
    dom.cleanup();
  }
});

domTest("a new request replaces a running automatic one, and the old answer never shows", async () => {
  const dom = createDomTestHarness();
  const { default: PdfViewer } = await import("../src/content/PdfViewer");
  const answers: ((blob: Blob) => void)[] = [];
  const make = () => () => new Promise<Blob>((resolve) => answers.push(resolve));
  const [request, setRequest] = createSignal(make());
  opened.length = 0;
  const dispose = render(() => <PdfViewer title="Report" autoLoad request={request()} />, dom.root);
  try {
    expect(answers).toHaveLength(1);
    setRequest(() => make());
    expect(answers).toHaveLength(2);
    answers[0]!(new Blob(["old"], { type: "application/pdf" }));
    await settle();
    expect(opened).toEqual([]);
    answers[1]!(new Blob(["new"], { type: "application/pdf" }));
    await settle();
    expect(await (opened[0] as Blob).text()).toBe("new");
  } finally {
    dispose();
    dom.cleanup();
  }
});

domTest("disabled changes leave shown bytes alone, and bytes replacing an address stop its request", async () => {
  const dom = createDomTestHarness();
  const { default: PdfViewer } = await import("../src/content/PdfViewer");
  const originalFetch = globalThis.fetch;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    },
    { preconnect: originalFetch.preconnect },
  );
  const [data, setData] = createSignal<Blob | string>("/files/a.pdf");
  const [disabled, setDisabled] = createSignal(false);
  const dispose = render(() => <PdfViewer title="Report" data={data()} disabled={disabled()} />, dom.root);
  try {
    await settle();
    expect(signal?.aborted).toBe(false);
    setData(pdf());
    expect(signal?.aborted).toBe(true);
    await settle();
    expect(viewer(dom.root).dataset.state).toBe("undrawable");
    setDisabled(true);
    setDisabled(false);
    await settle();
    expect(viewer(dom.root).dataset.state).toBe("undrawable");
  } finally {
    globalThis.fetch = originalFetch;
    dispose();
    dom.cleanup();
  }
});

domTest("an on-demand document pdf.js cannot draw can render again, and focus stays in the viewer meanwhile", async () => {
  const dom = createDomTestHarness();
  const { default: PdfViewer } = await import("../src/content/PdfViewer");
  let calls = 0;
  let answer!: (blob: Blob) => void;
  const dispose = render(
    () => (
      <PdfViewer
        title="Invoice"
        loadLabel="Render preview"
        request={() => {
          calls++;
          return calls === 1 ? Promise.resolve(pdf()) : new Promise<Blob>((resolve) => (answer = resolve));
        }}
      />
    ),
    dom.root,
  );
  try {
    click(viewer(dom.root).querySelector("button")!);
    await settle();
    expect(viewer(dom.root).dataset.state).toBe("undrawable");
    const again = [...viewer(dom.root).querySelectorAll("button")].find((button) => button.textContent === "Render preview")!;
    again.focus();
    click(again);
    expect(calls).toBe(2);
    expect(viewer(dom.root).dataset.state).toBe("loading");
    expect(dom.document.activeElement).toBe(viewer(dom.root));
    answer(pdf());
    await settle();
  } finally {
    dispose();
    dom.cleanup();
  }
});
