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

  const book = await contactsService.book.get({ id: bookId });
  if (!book) return ssr.error(c, 404);

  const permission = await contactsService.book.permission.forActor({
    bookId,
    actor: c.get("actor"),
    accessSubject: c.get("accessSubject"),
  });

  if (!hasPermission(permission, "read")) return ssr.error(c, 403);

  if (!hasPermission(permission, "write"))
    return c.redirect(`/app/contacts/${publicBookId}?contact=${publicContactId}&contactBook=${publicBookId}`, 302);

  const contact = await contactsService.contact.get({ bookId, id: contactId });
  if (!contact) return ssr.error(c, 404);

  const [projectedBook, projectedContact] = await Promise.all([projectBooks([book]), projectContacts([contact])]);
  return c.redirect(`/app/contacts/${projectedBook[0]!.id}?contact=${projectedContact[0]!.id}&contactBook=${projectedBook[0]!.id}`, 302);
});
