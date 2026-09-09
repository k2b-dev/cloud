import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor } from "@k2b/cloud/server";
import { ssr } from "../../../config";
import { contactsService } from "../../../service";
import { projectBooks, resolvePublicId } from "../../../service/public-resources";

export default ssr<AuthContext>(async (c) => {
  const user = expectUserBackedActor(c);
  const publicBookId = c.req.param("bookId") ?? "";
  const bookId = await resolvePublicId("books", publicBookId);
  if (!bookId) return ssr.error(c, 404);

  const book = await contactsService.book.get({ id: bookId });
  if (!book) return ssr.error(c, 404);

  const hasReadAccess = await contactsService.book.permission.canAccess({
    bookId,
    subject: { type: "user", userId: user.id },
    requiredLevel: "read",
  });

  const publicBook = (await projectBooks([book]))[0]!;
  if (!hasReadAccess) return ssr.error(c, 403);
  return c.redirect(`/app/contacts/${publicBook.id}`, 302);
});
