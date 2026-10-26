import type { FibelPlugin } from "@k2b/fibel";
import { withoutFencedCode } from "../scripts/markdown";
import { lessonPrefix, lessonsSlug, renderLessons } from "../src/docs/lessons";

/** Assemble fragments before Fibel renders or indexes any documentation surface. */
export function lessonsPlugin(): FibelPlugin {
  return {
    name: "lessons",
    transformContent(context) {
      const isDocs = (page: (typeof context.pages)[number]) => page.collection?.id === "docs" && page.locale.code === "en";
      const overview = context.pages.find((page) => isDocs(page) && page.slug === lessonsSlug);
      if (!overview) throw new Error("Missing Lessons learned source page");
      const fragments = context.pages.filter((page) => isDocs(page) && page.slug.startsWith(lessonPrefix));
      const entries = fragments.map((page) => ({ path: `${page.slug.slice(lessonPrefix.length)}.md`, body: page.raw }));
      overview.body = renderLessons(overview.body, entries);
      overview.raw = renderLessons(overview.raw, entries);
      const headings = new Map(
        [...overview.headings, ...fragments.flatMap((page) => page.headings)].map((heading) => [heading.text, heading]),
      );
      overview.headings = [...withoutFencedCode(overview.body).matchAll(/^(#{2,4})\s+(.+)$/gm)].map((match) => {
        const heading = headings.get(match[2].trim());
        if (!heading) throw new Error(`Missing Fibel heading metadata for ${match[2]}`);
        return heading;
      });
      context.pages = context.pages.filter((page) => !fragments.includes(page));
    },
  };
}
