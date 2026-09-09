import { ButtonLink } from "@k2b/ui";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { resolvePublicIdParam } from "../api/route-params";
import { ssr } from "../config";
import { gridsService } from "../service";
import RecordEventFailures from "./_components/RecordEventFailures.island";
import { gridsAdminMessages } from "./admin-messages";

export default ssr<AuthContext>(async (c) => {
  const baseId = await resolvePublicIdParam(c, "baseId", "base");
  const base = baseId ? await gridsService.base.get(baseId) : null;
  if (!base) return ssr.error(c, 404);
  const { t } = gridsAdminMessages.resolve([getLocale(c)]);
  const pageRaw = Number(c.req.query("page") ?? "1");
  const page = Number.isSafeInteger(pageRaw) && pageRaw > 0 && Number.isSafeInteger((pageRaw - 1) * 100) ? pageRaw : 1;
  const failures = await gridsService.workflow.runtime.listRecordEventFailures(base.id, 101, (page - 1) * 100);
  const items = failures.slice(0, 100).map(({ baseId: _baseId, payload: _payload, ...failure }) => failure);
  return () => (
    <AdminLayout c={c} title={t.eventFailures}>
      <div class="app-rows">
        <ButtonLink href="/admin/grids" variant="secondary" size="sm">
          Grids
        </ButtonLink>
        <h1 class="text-base font-semibold text-primary">
          {base.name}: {t.eventFailures}
        </h1>
        <p class="text-sm text-dimmed">{t.eventFailuresDescription}</p>
        <RecordEventFailures baseId={base.shortId} items={items} />
        <nav class="flex gap-2" aria-label={t.eventPages}>
          {page > 1 && (
            <ButtonLink variant="secondary" size="sm" href={`?page=${page - 1}`}>
              {t.eventPrevious}
            </ButtonLink>
          )}
          {failures.length > 100 && (
            <ButtonLink variant="secondary" size="sm" href={`?page=${page + 1}`}>
              {t.eventNext}
            </ButtonLink>
          )}
        </nav>
      </div>
    </AdminLayout>
  );
});
