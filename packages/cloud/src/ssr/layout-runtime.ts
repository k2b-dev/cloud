export type LayoutBreadcrumb = {
  title: string;
  href?: string;
};

export type LayoutUpdate = {
  title?: string;
  breadcrumbs?: LayoutBreadcrumb[];
};

export const LAYOUT_UPDATE_EVENT = "cloud:layout:update";

/** The `@k2b/ui` custom property that names the page in a workspace's compact bar. */
export const APP_WORKSPACE_TITLE_PROPERTY = "--k2b-app-workspace-title";

/**
 * A CSS string literal that shows `value` as text. Control characters become
 * spaces; quotes, backslashes, and angle brackets become CSS escapes, so the
 * literal cannot end early and carries no markup into an HTML attribute.
 */
export const cssString = (value: string): string =>
  `"${value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/["\\<>]/g, (character) => `\\${character.charCodeAt(0).toString(16)} `)}"`;

export const layout = {
  update(update: LayoutUpdate) {
    if (typeof window === "undefined") return;

    const title = update.title ?? update.breadcrumbs?.at(-1)?.title;
    if (title) {
      document.title = title;
      document.querySelector<HTMLElement>(".cloud-app-canvas")?.style.setProperty(APP_WORKSPACE_TITLE_PROPERTY, cssString(title));
    }

    window.dispatchEvent(new CustomEvent<LayoutUpdate>(LAYOUT_UPDATE_EVENT, { detail: update }));
  },
};
