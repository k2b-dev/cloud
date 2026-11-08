import * as ui from "@k2b/ui";

/**
 * How many components `@k2b/ui` exports, counted from the package itself: capitalized names such as `Button`, not
 * helpers or constants. Server-only; the catalog page shows it, so no pull request maintains a number by hand.
 */
export const portableUiComponentCount = Object.keys(ui).filter((name) => /^[A-Z][a-z]/.test(name)).length;
