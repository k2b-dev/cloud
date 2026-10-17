import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor } from "@k2b/cloud/server";
import { ssr } from "../../../config";
import { contactsService } from "../../../service";
import { projectBooks, resolvePublicId } from "../../../service/public-resources";

export default ssr<AuthContext>(async (c) => {
  expectUserBackedActor(c);
  const publicBookId = c.req.param("bookId") ?? "";
  const bookId = await resolvePublicId("books", publicBookId);
  if (!bookId) return ssr.error(c, 404);

  const bookResult = await contactsService.book.get({ actor: c.get("actor"), accessSubject: c.get("accessSubject"), id: bookId });
  if (!bookResult.ok) return ssr.error(c, bookResult.error.code === "NOT_FOUND" ? 404 : 403);
  const { book } = bookResult.data;

  const publicBook = (await projectBooks([book]))[0]!;
  return c.redirect(`/app/contacts/${publicBook.id}`, 302);
});
