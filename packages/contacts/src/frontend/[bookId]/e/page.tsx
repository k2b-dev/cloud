import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, hasPermission } from "@k2b/cloud/server";
import { ssr } from "../../../config";
import { contactsService } from "../../../service";
import { projectBooks, resolvePublicId } from "../../../service/public-resources";

export default ssr<AuthContext>(async (c) => {
  expectUserBackedActor(c);
  const publicBookId = c.req.param("bookId") ?? "";
  const bookId = await resolvePublicId("books", publicBookId);
  if (!bookId) return ssr.error(c, 404);

  const book = await contactsService.book.get({ id: bookId });
  if (!book) return ssr.error(c, 404);

  const permission = await contactsService.book.permission.forActor({
    bookId,
    actor: c.get("actor"),
    accessSubject: c.get("accessSubject"),
  });

  const publicBook = (await projectBooks([book]))[0]!;
  if (!hasPermission(permission, "read")) return ssr.error(c, 403);
  return c.redirect(`/app/contacts/${publicBook.id}`, 302);
});
