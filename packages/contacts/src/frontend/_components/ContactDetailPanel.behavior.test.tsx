import { expect, spyOn, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return {
      Panel: (await import("./ContactDetailPanel.island")).default,
      LocaleProvider: (await import("@k2b/ui")).LocaleProvider,
    };
  } finally {
    dom.cleanup();
  }
};
const components = isServer ? undefined : await load();

if (!components) test.skip("runs with Solid DOM conditions", () => {});
else {
  const { Panel, LocaleProvider } = components;
  test("loading, failed, and empty detail renders keep the Contacts back control", async () => {
    const dom = createDomTestHarness();
    delegateEvents(["click"], dom.document);
    window.history.replaceState({}, "", "/app/contacts/team?search=Ada&contact=ada&contactBook=team");
    const response = Promise.withResolvers<Response>();
    const fetch = spyOn(globalThis, "fetch").mockReturnValue(response.promise);
    const dispose = render(
      () => (
        <LocaleProvider locale="de">
          <Panel
            initialContact={null}
            initialContactId="ada"
            initialBookId="team"
            initialNotesPage={{ items: [], page: 1, perPage: 30, total: 0, hasNext: false }}
            contacts={[]}
            bookNames={{ team: "Team" }}
            writableBooks={[]}
            adminBookIds={[]}
            currentUserId="user-1"
            initialFavoriteKeys={[]}
          />
        </LocaleProvider>
      ),
      dom.root,
    );
    const back = () => {
      const button = dom.root.querySelector<HTMLButtonElement>(".contacts-detail-back-bar button.contacts-detail-back");
      expect(button).not.toBeNull();
      expect(button!.textContent).toBe("Kontakte");
      expect(button!.getAttribute("data-variant")).toBe("ghost");
      return button!;
    };
    try {
      expect(dom.root.textContent).toContain("Kontakt wird geladen");
      back();
      response.resolve(Response.json({ message: "Load failed" }, { status: 500 }));
      // Drain the fetch, error-body, and query settlement promises without advancing a timer.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(dom.root.textContent).toContain("Load failed");
      back().click();
      expect(window.location.search).toBe("?search=Ada");
      back();
      expect(dom.root.textContent).not.toContain("Load failed");
    } finally {
      dispose();
      fetch.mockRestore();
      dom.cleanup();
    }
  });
}
