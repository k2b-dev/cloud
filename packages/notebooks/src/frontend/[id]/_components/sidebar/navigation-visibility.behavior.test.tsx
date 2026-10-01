import { describe, expect, test } from "bun:test";
import { Show } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";

describe("notebook navigation visibility", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  /** The real workspace sidebar beside the control that shows it again and a stand-in note editor. */
  const mount = async () => {
    const dom = createDomTestHarness();
    const { AppWorkspace } = await import("@k2b/ui");
    const { createNavigationHidden, followStoredNavigationHidden, NOTEBOOK_NAVIGATION_ID, setNavigationHidden } = await import(
      "./navigation-visibility"
    );
    let hidden: () => boolean = () => false;
    const dispose = render(() => {
      hidden = createNavigationHidden(false);
      followStoredNavigationHidden(hidden);
      return (
        <>
          <AppWorkspace>
            <AppWorkspace.Sidebar id={NOTEBOOK_NAVIGATION_ID} label="Navigation" hidden={hidden()} onHiddenChange={setNavigationHidden}>
              <AppWorkspace.SidebarDesktop>
                <a href="#team-notes">Team notes</a>
              </AppWorkspace.SidebarDesktop>
            </AppWorkspace.Sidebar>
          </AppWorkspace>
          <button type="button" aria-controls={NOTEBOOK_NAVIGATION_ID}>
            Toggle
          </button>
          {/* Like the floating control on views without the editor toolbar. */}
          <Show when={hidden()}>
            <button type="button" data-floating on:click={() => setNavigationHidden(false)}>
              Show navigation
            </button>
          </Show>
          <textarea aria-label="Note" />
        </>
      );
    }, dom.root);
    const element = (selector: string) => dom.document.querySelector<HTMLElement>(selector)!;
    return {
      dom,
      hidden: () => hidden(),
      setNavigationHidden,
      element,
      cleanup: () => {
        dispose();
        dom.cleanup();
      },
    };
  };

  test("hiding with focus on a navigation link moves focus to the control that shows it again", async () => {
    const view = await mount();
    try {
      view.element('a[href="#team-notes"]').focus();
      view.setNavigationHidden(true);
      expect(view.hidden()).toBe(true);
      expect(view.dom.document.querySelector('a[href="#team-notes"]')).toBeNull();
      expect(view.dom.document.activeElement).toBe(view.element("button[aria-controls]"));
    } finally {
      view.cleanup();
    }
  });

  test("the note editor can claim the focus that hiding removed", async () => {
    const view = await mount();
    const { NAVIGATION_FOCUS_EVENT } = await import("./navigation-visibility");
    const claim = (event: Event) => {
      event.preventDefault();
      view.element("textarea").focus();
    };
    window.addEventListener(NAVIGATION_FOCUS_EVENT, claim);
    try {
      view.element('a[href="#team-notes"]').focus();
      view.setNavigationHidden(true);
      expect(view.dom.document.activeElement).toBe(view.element("textarea"));
    } finally {
      window.removeEventListener(NAVIGATION_FOCUS_EVENT, claim);
      view.cleanup();
    }
  });

  test("focus outside the navigation stays where it is", async () => {
    const view = await mount();
    const { NAVIGATION_FOCUS_EVENT } = await import("./navigation-visibility");
    let requests = 0;
    const count = () => void requests++;
    window.addEventListener(NAVIGATION_FOCUS_EVENT, count);
    try {
      view.element("textarea").focus();
      view.setNavigationHidden(true);
      view.setNavigationHidden(false);
      expect(view.dom.document.activeElement).toBe(view.element("textarea"));
      expect(requests).toBe(0);
    } finally {
      window.removeEventListener(NAVIGATION_FOCUS_EVENT, count);
      view.cleanup();
    }
  });

  test("showing from a control that disappears moves focus into the navigation", async () => {
    const view = await mount();
    try {
      view.setNavigationHidden(true);
      view.element("[data-floating]").focus();
      view.element("[data-floating]").click();
      expect(view.hidden()).toBe(false);
      expect(view.dom.document.querySelector("[data-floating]")).toBeNull();
      expect(view.dom.document.activeElement).toBe(view.element('a[href="#team-notes"]'));
    } finally {
      view.cleanup();
    }
  });

  test("a tab that comes back into view follows a change made in another tab", async () => {
    const view = await mount();
    const { writeNavigationHidden } = await import("../settings/NotebookSettingsStore");
    try {
      writeNavigationHidden(true);
      expect(view.hidden()).toBe(false);
      window.dispatchEvent(new Event("focus"));
      expect(view.hidden()).toBe(true);
      expect(view.dom.document.querySelector('a[href="#team-notes"]')).toBeNull();
    } finally {
      view.cleanup();
    }
  });
});
