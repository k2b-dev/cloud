import {
  defineListQuery,
  field,
  type ListQueryStateOf,
  type LookupItem,
  type LookupLoadResult,
  type ViewStore,
} from "@k2b/ui/v2/list-query";

const t = (text: string): string => text;

const STATUS_OPTIONS = [
  { value: "consigned", label: t("Consigned") },
  { value: "sold", label: t("Sold") },
] as const;

// The application's own data, read with its own access checks.
const CONSIGNORS: readonly LookupItem[] = [
  { value: "c-1001", label: "Anna Berg", meta: "Munich" },
  { value: "c-1002", label: "Jonas Berger" },
];

const searchConsignors = async (query: string, context: { signal: AbortSignal; limit: number }): Promise<LookupLoadResult> => {
  context.signal.throwIfAborted();
  const items = CONSIGNORS.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));
  return { items: items.slice(0, context.limit) };
};

const consignorNames = async (values: readonly string[], context: { signal: AbortSignal }): Promise<readonly LookupItem[]> => {
  context.signal.throwIfAborted();
  return CONSIGNORS.filter((item) => values.includes(item.value));
};

export const articleQuery = defineListQuery({
  key: "articles",
  fields: {
    status: field.choice({ label: t("Status"), options: STATUS_OPTIONS, common: true }),
    price: field.numberRange({ label: t("Price"), unit: "€" }),
    consignor: field.lookup({ label: t("Consignor"), load: searchConsignors, resolve: consignorNames }),
    received: field.dateRange({
      label: t("Received"),
      presets: [{ value: "last-30d", label: t("Last 30 days") }],
    }),
  },
  search: { label: t("Number or title") },
  sort: {
    options: { received: { label: t("Received") }, price: { label: t("Price") } },
    default: { field: "received", direction: "desc" },
  },
  group: { status: { label: t("Status") } },
  pageParams: ["selected"],
});

export type ArticleState = ListQueryStateOf<typeof articleQuery>;

export const readArticleQuery = (requestUrl: string) => {
  const { state, issues } = articleQuery.parse(new URL(requestUrl).searchParams);
  const status: readonly ("consigned" | "sold")[] | undefined = state.filters.status;
  const href = `?${articleQuery.serialize(articleQuery.set(state, "price", { min: 500 }))}`;
  return { state, issues, status, href };
};

/** The application implements its own store; this one keeps views in memory for the example only. */
export const memoryViews = (): ViewStore => {
  const views = new Map<string, { key: string; label: string; query: string }>();
  return {
    scope: "person",
    writable: true,
    list: async () => [...views.values()],
    save: async (view) => {
      const saved = { key: view.key ?? `own-${views.size + 1}`, label: view.label, query: view.query };
      views.set(saved.key, saved);
      return saved;
    },
    remove: async (key) => {
      views.delete(key);
    },
  };
};
