import { expect, test } from "bun:test";
import { contactsPrimaryHref } from "./_components/contacts-primary";
import { contactsFiltered, contactsViewHref, resetContactsFiltersHref } from "./contacts-query";

for (const query of ["", "?sort=created", "?favorites=true", "?search=%20%20&email=all&phone=all"]) {
  test(`view and sort do not count as filters: ${query}`, () => expect(contactsFiltered(`/app/contacts${query}`)).toBe(false));
}
for (const query of ["?search=Ada", "?tag_id=vip", "?email=yes", "?phone=no"]) {
  test(`narrowing filters count: ${query}`, () => expect(contactsFiltered(`/app/contacts${query}`)).toBe(true));
}
test("view links retain the object's filters, clear pagination and detail, and toggle favorites", () => {
  const source =
    "/app/contacts/team?favorites=true&sort=updated&search=Ada&tag_id=vip&email=yes&phone=no&page=4&contact=ada&contactBook=team";
  expect(contactsViewHref(source, false)).toBe("/app/contacts/team?sort=updated&search=Ada&tag_id=vip&email=yes&phone=no");
  expect(contactsViewHref(source, true)).toBe("/app/contacts/team?sort=updated&search=Ada&tag_id=vip&email=yes&phone=no&favorites=true");
  expect(resetContactsFiltersHref(source)).toBe("/app/contacts/team?favorites=true&sort=updated");
});
test("primary command links preserve the route and use a bare object path for an oversized query", () => {
  const href = contactsPrimaryHref("/app/contacts/team?favorites=true", "team");
  expect(href).toContain("/app/contacts/team?favorites=true&");
  expect(href).toContain("contacts.contact.compose");
  const long = contactsPrimaryHref(`/app/contacts/team?search=${"x".repeat(20000)}`, "team");
  expect(long).not.toContain("search=");
  expect(long).toStartWith("/app/contacts/team?");
});
