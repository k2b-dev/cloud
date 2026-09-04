import { NotFoundState } from "@k2b/ui";
import type { Context } from "hono";
import type { PageErrorOptions, PageErrorStatus } from "../_internal/page-responses";
import { getLocale } from "../server/locale";
import Layout from "./Layout";
import MinimalLayout from "./MinimalLayout";
import { pageErrorMessages } from "./page-error-messages";

export const renderPageError = (c: Context, status: PageErrorStatus, options: PageErrorOptions) => {
  const { t } = pageErrorMessages.resolve([getLocale(c)]);
  const title = options.title ?? (status === 403 ? t.forbidden : status === 404 ? t.notFound : t.failed);
  const description =
    options.description ?? (status === 403 ? t.forbiddenDescription : status === 404 ? t.notFoundDescription : t.failedDescription);
  const action = options.action ?? { label: t.home, href: "/" };
  c.get("page").title = title;

  return () =>
    options.layout === "minimal" ? (
      <MinimalLayout c={c}>
        <main class="min-h-screen bg-[var(--ui-canvas)] p-[var(--ui-space-shell)]">
          <NotFoundState code={String(status)} title={title} description={description} action={action} />
        </main>
      </MinimalLayout>
    ) : (
      <Layout c={c} title={title}>
        <NotFoundState code={String(status)} title={title} description={description} action={action} />
      </Layout>
    );
};
