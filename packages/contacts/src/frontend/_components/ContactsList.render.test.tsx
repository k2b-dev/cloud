import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
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
  const html = renderToString(() => (
    <ContactsList
      contacts={[contact]}
      initialSelectedContactId={null}
      initialSelectedBookId={null}
      detailBaseHref="/app/contacts/team"
      initialFavoriteKeys={["team:ada"]}
      selectionMode
      selectedIds={[contact.id]}
    />
  ));

  const checkbox = html.match(/<label class="k2b-check"[^>]*><input\b[^>]*>/)?.[0];
  expect(checkbox).toContain('type="checkbox"');
  expect(checkbox).toContain('aria-label="Select Ada Lovelace"');
  expect(checkbox).toMatch(/\schecked(?:=""|="checked")?(?=[\s>])/);
  expect(html).not.toContain('class="h-4 w-4"');
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
  const favorite = html.match(/<button\b[^>]*aria-pressed="true"[^>]*>/)?.[0];
  expect(favorite).toMatch(/class="[^"]*\bk2b-icon-button\b/);
  expect(favorite).toContain('aria-label="Remove from favorites"');
});
