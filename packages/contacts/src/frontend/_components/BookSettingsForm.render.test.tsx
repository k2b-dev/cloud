import { describe, expect, test } from "bun:test";
import { renderToString } from "solid-js/web";
import type { ContactBook, ContactTag } from "../../service";
import "./ssr-test-plugin";

const { default: BookSettingsForm } = await import("./BookSettingsForm.tsx");
const { default: ContactsSidebar } = await import("./ContactsSidebar.tsx");
const { default: ContactsSpotlightButton } = await import("./ContactsSpotlightButton.island.tsx");

const tag: ContactTag = {
  id: "tag-1",
  bookId: "book-1",
  name: "Supplier",
  color: "#2563eb",
  createdAt: "2026-08-10T10:00:00.000Z",
  updatedAt: "2026-08-10T10:00:00.000Z",
};

const book: ContactBook = {
  id: "book-1",
  name: "Suppliers",
  description: "External suppliers",
  createdAt: "2026-08-10T10:00:00.000Z",
  updatedAt: "2026-08-10T10:00:00.000Z",
};

describe("Contact book settings", () => {
  test("renders grouped modal navigation and a persistent metadata footer", () => {
    const html = renderToString(() => (
      <BookSettingsForm
        context={() => ({ book, accessEntries: [], apiKeys: [], tags: [tag] })}
        onClose={() => undefined}
        onDeleted={() => undefined}
        onWorkspaceChange={() => undefined}
        onReconcile={async () => undefined}
      />
    ));

    expect(html).toContain('aria-label="Contact book settings sections"');
    expect(html).toContain("Book");
    expect(html).toContain("Sharing");
    expect(html).toContain("Data");
    expect(html).toContain("Lifecycle");
    expect(html).toContain("General");
    expect(html).toContain("Tags");
    expect(html).toContain("Access");
    expect(html).toContain("API keys");
    expect(html).toContain("Import &amp; export");
    expect(html).toContain("Danger zone");
    expect(html).toContain('class="k2b-settings-group"');
    expect(html).toContain('class="k2b-settings__footer"');
    expect(html).toContain("No unsaved changes");
    expect(html).not.toContain("Mailbox admins");
  });

  test("can open directly on tag management", () => {
    const html = renderToString(() => (
      <BookSettingsForm
        context={() => ({ book: { ...book, description: null }, accessEntries: [], apiKeys: [], tags: [tag] })}
        initialTab="tags"
        onClose={() => undefined}
        onDeleted={() => undefined}
        onWorkspaceChange={() => undefined}
        onReconcile={async () => undefined}
      />
    ));

    expect(html).toContain("Vocabulary");
    expect(html).toContain("Supplier");
    expect(html).toContain('class="k2b-tag-editor ');
    expect(html).not.toContain("No unsaved changes");
  });

  test("exposes modal settings actions in desktop and mobile navigation", () => {
    const html = renderToString(() => <ContactsSidebar books={[book]} active={book.id} adminBookIds={[book.id]} />);

    expect(html.match(/aria-label="Open settings for Suppliers"/g)).toHaveLength(1);
    const navigationJson = html.match(/<script[^>]*data-cloud-workspace-navigation[^>]*>(.*?)<\/script>/s)?.[1];
    expect(navigationJson).toBeDefined();
    const navigation = JSON.parse(navigationJson!);
    expect(navigation.items).toContainEqual(
      expect.objectContaining({
        id: book.id,
        active: true,
        href: `/app/contacts/${book.id}`,
        actions: [
          expect.objectContaining({
            action: `settings:${book.id}`,
            label: "Open settings for Suppliers",
          }),
        ],
      }),
    );
    expect(html).not.toContain("/app/contacts/book-1/settings");
  });

  test("omits settings actions from both navigations without book administration", () => {
    const html = renderToString(() => <ContactsSidebar books={[book]} active={book.id} adminBookIds={[]} />);

    expect(html).not.toContain("Open settings for Suppliers");
    expect(html).not.toContain(`settings:${book.id}`);
    expect(html).toContain(`/app/contacts/${book.id}`);
  });

  test("uses the workspace icon action geometry for collapsed search", () => {
    const html = renderToString(() => <ContactsSpotlightButton variant="icon" />);

    expect(html).toContain("k2b-app-workspace__sidebar-icon-action");
    expect(html).not.toContain("k2b-spotlight-button");
  });
});
