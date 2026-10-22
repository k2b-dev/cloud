import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, hasPermission } from "@k2b/cloud/server";
import { ssr } from "../../../../config";
import { contactsService } from "../../../../service";
import { projectBooks, projectContacts, resolveBookPublicIds, resolvePublicId } from "../../../../service/public-resources";

export default ssr<AuthContext>(async (c) => {
  expectUserBackedActor(c);
  const publicBookId = c.req.param("bookId") ?? "";
  const publicContactId = c.req.param("contactId") ?? "";
  const bookId = await resolvePublicId("books", publicBookId);
  if (!bookId) return ssr.error(c, 404);
  const [contactId] = (await resolveBookPublicIds("contacts", bookId, [publicContactId])) ?? [];
  if (!contactId) return ssr.error(c, 404);

  const bookResult = await contactsService.book.get({ actor: c.get("actor"), accessSubject: c.get("accessSubject"), id: bookId });
  if (!bookResult.ok) return ssr.error(c, bookResult.error.code === "NOT_FOUND" ? 404 : 403);
  const { book, permission } = bookResult.data;

  if (!hasPermission(permission, "write"))
    return c.redirect(`/app/contacts/${publicBookId}?contact=${publicContactId}&contactBook=${publicBookId}`, 302);

  const contact = await contactsService.contact.get({
    actor: c.get("actor"),
    accessSubject: c.get("accessSubject"),
    bookId,
    id: contactId,
  });
  if (!contact.ok) return ssr.error(c, contact.error.code === "NOT_FOUND" ? 404 : 403);
  if (!contact.data) return ssr.error(c, 404);

  const [projectedBook, projectedContact] = await Promise.all([projectBooks([book]), projectContacts([contact.data])]);
  return c.redirect(`/app/contacts/${projectedBook[0]!.id}?contact=${projectedContact[0]!.id}&contactBook=${projectedBook[0]!.id}`, 302);
});
