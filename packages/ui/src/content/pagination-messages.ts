import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const paginationMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      pagination: "Pagination",
      pageOf: ({ page, total }: { page: number; total: number }) => `Page ${page} of ${total}`,
      previousPage: "Previous page",
      nextPage: "Next page",
      goToPage: ({ page }: { page: number }) => `Go to page ${page}`,
    },
    de: {
      pagination: "Seitennavigation",
      pageOf: ({ page, total }) => `Seite ${page} von ${total}`,
      previousPage: "Vorherige Seite",
      nextPage: "Nächste Seite",
      goToPage: ({ page }) => `Zu Seite ${page}`,
    },
  },
});

export type PaginationMessages = ReturnType<(typeof paginationMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const usePaginationMessages = (): (() => PaginationMessages) => {
  const locale = useLocale();
  return () => paginationMessages.resolve([locale()]).t;
};

export const checkPaginationMessages = () => paginationMessages.check();
