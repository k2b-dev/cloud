import { DataTable, type DataTableColumn, Pagination, StatCell, StatGrid } from "@k2b/ui";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { getLocale } from "@valentinkolb/cloud/server";
import { AdminLayout } from "@valentinkolb/cloud/ssr";
import { SearchBar } from "@valentinkolb/cloud/ssr/islands";
import { ssr } from "../config";
import { contactsService } from "../service";
import { projectBooks } from "../service/public-resources";
import AdminBookActions from "./_components/AdminBookActions.island";
import { pagesMessages } from "./pages-messages";

const PER_PAGE = 100;

export default ssr<AuthContext>(async (c) => {
  const { t } = pagesMessages.resolve([getLocale(c)]);
  const search = (c.req.query("search") ?? "").trim();
  const pageRaw = Number.parseInt(c.req.query("page") ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  const [books, summary] = await Promise.all([
    contactsService.book.admin.list({
      pagination: { page, perPage: PER_PAGE },
      filter: { query: search || undefined },
    }),
    contactsService.book.admin.summary({ filter: { query: search || undefined } }),
  ]);
  const publicBooks = await projectBooks(books.items);

  const totalPages = Math.ceil(books.total / books.perPage);
  const baseUrl = search ? `/admin/contacts?search=${encodeURIComponent(search)}&page=` : "/admin/contacts?page=";
  type BookRow = (typeof books.items)[number];
  const columns: DataTableColumn<BookRow>[] = [
    { id: "book", header: t.columnBook, value: (book) => book.name },
    { id: "description", header: t.columnDescription, value: (book) => book.description, cellClass: "max-w-xl" },
    { id: "contacts", header: t.columnContacts, value: (book) => book.contactCount, cellClass: "whitespace-nowrap tabular-nums" },
    { id: "permissions", header: t.columnPermissions, value: (book) => book.permissionCount, cellClass: "whitespace-nowrap" },
    {
      id: "actions",
      header: t.columnSettings,
      headerClass: "w-px text-right",
      cellClass: "text-right whitespace-nowrap",
    },
  ];

  return () => (
    <AdminLayout c={c} title={t.adminTitle}>
      <div class="app-rows">
        <div class="min-w-0" style="view-transition-name: admin-contacts-title">
          <h1 class="text-base font-semibold text-primary">{t.adminTitle}</h1>
        </div>

        <StatGrid columns={4}>
          <StatCell
            label={t.statBooks}
            value={summary.total}
            sub={search ? t.statBooksFiltered : t.statBooksAll}
            accent={{ tone: "blue", icon: "ti ti-cube" }}
          />
          <StatCell
            label={t.statOrphaned}
            value={summary.orphaned}
            sub={summary.orphaned > 0 ? t.statOrphanedNoAccess : t.statOrphanedAllReachable}
            valueClass={summary.orphaned > 0 ? "text-red-500" : "text-primary"}
            accent={summary.orphaned > 0 ? { tone: "red", icon: "ti ti-alert-circle" } : undefined}
          />
          <StatCell label={t.statAccessEntries} value={summary.totalPermissions} sub={search ? t.statInSearch : t.statAcrossAllBooks} />
          <StatCell label={t.statContacts} value={summary.totalContacts} sub={search ? t.statInSearch : t.statAllContacts} />
        </StatGrid>

        <section class="paper overflow-hidden" style="view-transition-name: admin-contacts-table">
          <div class="flex flex-col gap-2 px-3 py-3">
            <div>
              <h2 class="text-xs font-semibold text-primary">{t.booksHeading}</h2>
              <p class="text-[10px] text-dimmed">{t.booksCount({ count: publicBooks.length, total: books.total })}</p>
            </div>
            <SearchBar
              action="/admin/contacts"
              value={search}
              placeholder={t.adminSearchPlaceholder}
              ariaLabel={t.adminSearchLabel}
            />
          </div>
          <DataTable
            rows={publicBooks}
            columns={columns}
            getRowId={(book) => book.id}
            hoverRows
            class="overflow-x-auto"
            empty={search ? t.emptyFiltered({ search }) : t.emptyAll}
            renderCell={({ row: book, col }) => {
              if (col.id === "book") {
                return (
                  <div class="flex min-w-52 items-center gap-2">
                    <i class="ti ti-cube text-dimmed" />
                    <span class="truncate font-medium text-primary">{book.name}</span>
                  </div>
                );
              }
              if (col.id === "description") {
                return (
                  <span class="block truncate" title={book.description ?? t.noDescription}>
                    {book.description || <span class="italic">{t.noDescription}</span>}
                  </span>
                );
              }
              if (col.id === "contacts") return <span class="text-xs text-dimmed">{book.contactCount}</span>;
              if (col.id === "permissions") {
                return (
                  <span
                    class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      book.permissionCount === 0
                        ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                        : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                    }`}
                  >
                    {t.accessEntryCount({ count: book.permissionCount })}
                  </span>
                );
              }
              if (col.id === "actions") return <AdminBookActions bookId={book.id} bookName={book.name} />;
              return "";
            }}
          />
        </section>

        <Pagination currentPage={books.page} totalPages={totalPages} baseUrl={baseUrl} />
      </div>
    </AdminLayout>
  );
});
