import { describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

describe("@k2b/ui Discussion behavior", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("keeps failed drafts, clears accepted drafts, and clears a rejection with any edit", async () => {
    const dom = createDomTestHarness();
    const { default: Discussion } = await import("../src/layout/Discussion");
    let accepted = false;
    const submissions: string[] = [];
    const dispose = render(
      () => (
        <Discussion.Composer
          label="Add comment"
          onSubmit={(message) => {
            submissions.push(message);
            return accepted;
          }}
        />
      ),
      dom.root,
    );
    const textarea = dom.root.querySelector<HTMLTextAreaElement>("textarea")!;
    const submit = dom.root.querySelector<HTMLButtonElement>('button[type="submit"]')!;

    textarea.value = "  Keep this draft  ";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    submit.click();
    await Promise.resolve();
    expect(submissions).toEqual(["Keep this draft"]);
    expect(textarea.value).toBe("  Keep this draft  ");

    accepted = true;
    submit.click();
    await Promise.resolve();
    expect(submissions).toEqual(["Keep this draft", "Keep this draft"]);
    expect(textarea.value).toBe("");
    dispose();

    // A rejection shows under the composer until the draft changes, also when the user clears it.
    const disposeRejecting = render(
      () => (
        <Discussion.Composer
          label="Add comment"
          onSubmit={() => {
            throw new Error("Comments are closed");
          }}
        />
      ),
      dom.root,
    );
    const rejectedDraft = dom.root.querySelector<HTMLTextAreaElement>("textarea")!;
    const alerts = () => Array.from(dom.root.querySelectorAll('[role="alert"]'), (alert) => alert.textContent).filter(Boolean);
    rejectedDraft.value = "Can we move this?";
    rejectedDraft.dispatchEvent(new Event("input", { bubbles: true }));
    dom.root.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(alerts()).toEqual(["Comments are closed"]);
    rejectedDraft.value = "";
    rejectedDraft.dispatchEvent(new Event("input", { bubbles: true }));
    expect(alerts()).toEqual([]);

    disposeRejecting();
    dom.cleanup();
  });

  test("loads earlier entries when its sentinel becomes visible without rendering an empty placeholder", async () => {
    const dom = createDomTestHarness();
    const previousObserver = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
    let loads = 0;
    class ImmediateIntersectionObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(element: Element) {
        this.callback([{ isIntersecting: true, target: element } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      disconnect() {}
      unobserve() {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
    }
    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      writable: true,
      value: ImmediateIntersectionObserver,
    });
    const { default: Discussion } = await import("../src/layout/Discussion");
    const dispose = render(
      () => (
        <Discussion label="Comments" count={0}>
          <Discussion.List
            hasMore
            onLoadMore={() => {
              loads++;
              return false;
            }}
          />
        </Discussion>
      ),
      dom.root,
    );
    await Promise.resolve();

    expect(loads).toBe(1);
    expect(dom.root.textContent).not.toContain("No comments");
    expect(dom.root.querySelector(".k2b-discussion__count")?.textContent).toBe("0");

    dispose();
    let retryCalls = 0;
    const errorRoot = dom.document.createElement("div");
    dom.root.append(errorRoot);
    const disposeError = render(
      () => (
        <Discussion label="Comments">
          <Discussion.List
            error="Could not load comments"
            hasMore
            onRetry={() => {
              retryCalls++;
            }}
            onLoadMore={() => {
              loads++;
            }}
          />
        </Discussion>
      ),
      errorRoot,
    );
    await Promise.resolve();
    expect(loads).toBe(1);
    const retryButton = errorRoot.querySelector<HTMLButtonElement>("button")! as HTMLButtonElement & {
      $$click?: (event: MouseEvent) => void;
    };
    retryButton.$$click?.(new MouseEvent("click"));
    expect(retryCalls).toBe(1);

    disposeError();
    const [loading, setLoading] = createSignal(true);
    const [hasMore, setHasMore] = createSignal(false);
    const transitionRoot = dom.document.createElement("div");
    dom.root.append(transitionRoot);
    const disposeTransition = render(
      () => (
        <Discussion label="Comments">
          <Discussion.List
            loading={loading()}
            hasMore={hasMore()}
            onLoadMore={() => {
              loads++;
              return false;
            }}
          />
        </Discussion>
      ),
      transitionRoot,
    );
    await Promise.resolve();
    expect(loads).toBe(1);

    setLoading(false);
    setHasMore(true);
    await Promise.resolve();
    expect(loads).toBe(2);
    expect(retryCalls).toBe(1);

    disposeTransition();
    if (previousObserver) Object.defineProperty(globalThis, "IntersectionObserver", previousObserver);
    else delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    dom.cleanup();
  });

  test("anchors the scroll owner and ignores history that resolves after disposal", async () => {
    const dom = createDomTestHarness();
    const previousObserver = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
    class ImmediateIntersectionObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(element: Element) {
        this.callback([{ isIntersecting: true, target: element } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      disconnect() {}
      unobserve() {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
    }
    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      writable: true,
      value: ImmediateIntersectionObserver,
    });
    const { default: Discussion } = await import("../src/layout/Discussion");
    const owner = dom.document.createElement("div");
    owner.style.overflow = "auto";
    dom.root.append(owner);
    let ownerScrollHeight = 100;
    Object.defineProperty(owner, "scrollHeight", { configurable: true, get: () => ownerScrollHeight });
    const [hasMore, setHasMore] = createSignal(true);
    const [items, setItems] = createSignal(["new"]);
    let resolveLoad!: () => void;
    const pendingLoad = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });
    const dispose = render(
      () => (
        <Discussion.List
          hasMore={hasMore()}
          onLoadMore={async () => {
            await pendingLoad;
            setItems(["old", "new"]);
            setHasMore(false);
            ownerScrollHeight = 180;
            return true;
          }}
        >
          {items().map((item) => (
            <li>{item}</li>
          ))}
        </Discussion.List>
      ),
      owner,
    );
    await Promise.resolve();
    resolveLoad();
    await pendingLoad;
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(owner.scrollTop).toBe(80);
    dispose();

    owner.scrollTop = 0;
    ownerScrollHeight = 100;
    let resolveDisposedLoad!: () => void;
    const disposedLoad = new Promise<void>((resolve) => {
      resolveDisposedLoad = resolve;
    });
    const disposedTarget = dom.document.createElement("div");
    owner.append(disposedTarget);
    const disposePending = render(
      () => (
        <Discussion.List
          hasMore
          onLoadMore={async () => {
            await disposedLoad;
            ownerScrollHeight = 180;
            return true;
          }}
        />
      ),
      disposedTarget,
    );
    await Promise.resolve();
    disposePending();
    resolveDisposedLoad();
    await disposedLoad;
    await Promise.resolve();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(owner.scrollTop).toBe(0);

    if (previousObserver) Object.defineProperty(globalThis, "IntersectionObserver", previousObserver);
    else delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    dom.cleanup();
  });
});
