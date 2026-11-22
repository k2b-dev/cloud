import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { Contact } from "../../service";
import "./ssr-test-plugin";

const { default: ContactsList } = await import("./ContactsList.tsx");

const now = "2026-10-17T12:00:00.000Z";
const contact: Contact = {
  id: "ada",
  bookId: "team",
  label: null,
  firstName: "Ada",
  lastName: "Lovelace",
  companyName: null,
  department: null,
  jobTitle: null,
  vatId: null,
  birthday: null,
  salutation: null,
  pronouns: null,
  preferredLanguage: null,
  source: null,
  createdAt: now,
  updatedAt: now,
  emails: [{ id: "email-1", contactId: "ada", label: "Work", email: "ada@example.com", position: 0, createdAt: now, updatedAt: now }],
  phones: [{ id: "phone-1", contactId: "ada", label: "Work", phone: "+442079460958", position: 0, createdAt: now, updatedAt: now }],
  addresses: [],
  websites: [],
  bankAccounts: [],
  parentContactId: null,
  parent: null,
  members: [],
  tags: [],
};

beforeEach(() => setSystemTime(new Date(now)));
afterEach(() => setSystemTime());

test("renders shared selection, call, email, and favorite controls with accessible labels", () => {
  const html = renderToString(() =>
    createComponent(ContactsList, {
      contacts: [contact],
      initialSelectedContactId: null,
      initialSelectedBookId: null,
      detailBaseHref: "/app/contacts/team",
      initialFavoriteKeys: ["team:ada"],
      selectionMode: true,
      selectedIds: [contact.id],
    }),
  );

  const checkbox = html.match(/<label class="k2b-check"[^>]*><input\b[^>]*>/)?.[0];
  expect(checkbox).toContain('type="checkbox"');
  expect(checkbox).toContain('aria-label="Select Ada Lovelace"');
  expect(checkbox).toMatch(/\schecked(?:=""|="checked")?(?=[\s>])/);
  expect(html).not.toContain('class="h-4 w-4"');
  // The row makes room for the checkbox with exactly one padding class: two arbitrary paddings on one element would
  // be decided by Tailwind's sort order, not by the condition (the plain gutter would win and the box cover the avatar).
  const row = html.match(/<a\b[^>]*data-contact-row[^>]*>/)?.[0] ?? html.match(/<a\b[^>]*class="contacts-list__row[^"]*"[^>]*>/)?.[0];
  expect(row).toContain("pl-[calc(var(--k2b-gutter)+1.75rem)]");
  expect(row).not.toMatch(/\bpl-\[var\(--k2b-gutter\)\]/);
  const links = html.match(/<a\b[^>]*>/g) ?? [];
  for (const [href, label] of [
    ["tel:+442079460958", "Call Ada Lovelace"],
    ["mailto:ada@example.com", "Email Ada Lovelace"],
  ]) {
    const link = links.find((tag) => tag.includes(`href="${href}"`));
    expect(link).toMatch(/class="[^"]*\bk2b-icon-button\b/);
    expect(link).toContain(`aria-label="${label}"`);
  }
  expect(html).not.toContain("focus-ui");
  expect(html).not.toContain("bg-[var(--ui-surface-subtle)]");
  expect(html).not.toContain("p-1.5");
  const favorite = html.match(/<button\b[^>]*aria-pressed="true"[^>]*>/)?.[0];
  expect(favorite).toMatch(/class="[^"]*\bk2b-icon-button\b/);
  expect(favorite).toContain('aria-label="Remove from favorites"');
});
