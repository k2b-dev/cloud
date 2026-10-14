/** What the article head, the table of contents, and the step count read from the rendered Help HTML. */
export type HelpArticleParts = {
  /** The first paragraph: the article's short answer. */
  lead?: string;
  body: string;
  sections: { id: string; label: string }[];
  steps: number;
};

/**
 * Splits trusted Help HTML before it renders, so the head shows the short answer, the step count, and the
 * section menu in the same frame as the body and nothing moves afterwards.
 */
export const helpArticleParts = (html: string): HelpArticleParts => {
  // A template parses inert markup: nothing in it loads or runs.
  const template = document.createElement("template");
  template.innerHTML = html;
  const body = template.content;
  const first = body.firstElementChild;
  // A bold-only paragraph is an eyebrow (`help-eyebrow`), not the short answer.
  const lead = first?.tagName === "P" && !first.className ? first.outerHTML : undefined;
  if (lead) first?.remove();
  return {
    lead,
    body: template.innerHTML,
    sections: Array.from(body.querySelectorAll("h2[id]"), (heading) => ({
      id: heading.id,
      label: heading.textContent?.trim() ?? "",
    })).filter((section) => section.label),
    // Steps inside a collapsed `details` block are an aside, not the task.
    steps: Array.from(body.querySelectorAll(".help-steps > ol > li")).filter((step) => !step.closest("details")).length,
  };
};
