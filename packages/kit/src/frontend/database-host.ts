import { toast } from "@k2b/ui";
import { DatabaseRequest } from "../database-contracts";
import { importData, ImportInputError, ImportOptions, type ImportProgress } from "../database-import";
import { databaseMessages } from "../database-messages";
import { client, checked } from "./client";
/** One generation per run. Reset cannot silently redirect an old script. */
export function createDatabaseHost(id: string, locale: string) {
  let generation: number | undefined;
  const t = databaseMessages.resolve([locale]).t;
  return async (method: string, args: unknown[], signal: AbortSignal, progress: (p: ImportProgress) => void) => {
    if (generation === undefined) {
      const state = await checked(await client.projects[":id"].database.$get({ param: { id }, query: {} }, { init: { signal } }));
      if (!state.globallyEnabled) throw new Error(t.globalOff);
      if (!state.enabled || !state.provisioned) throw new Error(t.disabled);
      if (state.status === "provisioning") throw new Error(t.preparing);
      generation = state.generation;
    }
    const controller = new AbortController();
    const requestSignal = AbortSignal.any([signal, controller.signal]);
    const execute = async (request: DatabaseRequest) =>
      checked(
        await client.projects[":id"].database.call.$post(
          { param: { id }, json: { generation: generation!, request: DatabaseRequest.parse(request) } },
          { init: { signal: requestSignal } },
        ),
      );
    if (method === "db.call") return execute(DatabaseRequest.parse(args[0]));
    const options = ImportOptions.parse(args[2] ?? {});
    const notice = options.notify
      ? toast(t.validating, {
          title: t.import,
          progress: "indeterminate",
          dismissLabel: t.close,
          action: { label: t.cancel, onClick: () => controller.abort() },
        })
      : undefined;
    try {
      const result = await importData(
        String(args[0]),
        args[1],
        options,
        execute,
        (p) => {
          progress(p);
          notice?.update(t.count({ done: p.confirmedRows, total: p.totalRows }), {
            progress: p.phase === "validating" ? "indeterminate" : p.totalRows ? p.confirmedRows / p.totalRows : 1,
          });
        },
        requestSignal,
      );
      notice?.update(
        result.status === "complete"
          ? t.count({ done: result.confirmedRows, total: result.totalRows })
          : result.status === "cancelled"
            ? t.stopped
            : t.failed,
        {
          title: result.status === "complete" ? t.done : t.import,
          variant: result.status === "complete" ? "success" : "error",
          progress: null,
          action: null,
          duration: result.status === "complete" ? 5000 : 0,
        },
      );
      return result;
    } catch (error) {
      const description =
        error instanceof ImportInputError
          ? `${t.invalid} ${error.row ?? ""} ${error.column}`
          : error instanceof Error && error.message.startsWith("DB_")
            ? t.invalid
            : error instanceof Error
              ? error.message
              : t.failed;
      notice?.update(requestSignal.aborted ? t.stopped : description, { variant: "error", progress: null, action: null, duration: 0 });
      throw new Error(requestSignal.aborted ? t.stopped : description);
    }
  };
}
