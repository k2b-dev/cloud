import { expect, test } from "bun:test";
import { buildNotePdfHtml } from "./note-pdf";
import { prepareNotePdfImages } from "./note-pdf-images";

for (const cell of ["![Map](attach://ABC123)", "abc![Map](attach://ABC123)"]) {
  test(`table image slots survive PDF wrapping and become placeholders: ${cell}`, async () => {
    const built = buildNotePdfHtml({
      markdown: `| Image |\n| --- |\n| ${cell} |`,
      notebookShortId: "ABC123",
      locale: "en",
    });
    expect(built.images).toHaveLength(1);
    for (const image of built.images) expect(built.html).toContain(image.token);

    const prepared = await prepareNotePdfImages(
      {
        ...built,
        notebookId: "notebook",
        maxHtmlBytes: 1024 * 1024,
        maxAttachmentBytes: 1000,
        deadline: 10000,
        signal: new AbortController().signal,
        locale: "en",
      },
      {
        now: () => 100,
        list: async () => [],
        content: async () => {
          throw new Error("Missing images must not load content");
        },
        prepare: async () => {
          throw new Error("Missing images must not be prepared");
        },
      },
    );
    expect(prepared.html).not.toContain("NOTEBOOKBOOKSLOT");
    expect(prepared.html).toContain('<span class="notebook-book-image-missing"');
  });
}
