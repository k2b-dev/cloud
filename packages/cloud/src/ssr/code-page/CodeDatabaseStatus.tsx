import { ButtonLink, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import type { CodePageReady } from "./data";
import { codePageMessages } from "./messages";

/** Database storage and export controls shared by Code pages and Core administration. */
export function CodeDatabaseStatus(props: { codeId: string; database: NonNullable<CodePageReady["code"]["database"]> }) {
  const locale = useLocale();
  const t = () => codePageMessages.resolve([locale()]).t;
  const mb = (bytes: number) =>
    new Intl.NumberFormat(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(bytes / 1048576);
  return (
    <span class="inline-flex flex-wrap items-center gap-x-3 gap-y-2">
      <span>
        <i class="ti ti-database" aria-hidden="true" />{" "}
        {props.database.bytes === null
          ? t().databaseUnavailable
          : t().databaseUsage({ used: mb(props.database.bytes), limit: mb(props.database.limit) })}
      </span>
      <Show when={props.database.owner}>
        {(owner) => <span>{t().databaseOwner({ used: mb(owner().reserved), limit: mb(owner().limit) })}</span>}
      </Show>
      <Show when={props.database.canExport && props.database.state !== "unused"}>
        <ButtonLink
          size="sm"
          variant="secondary"
          href={`/api/code/authoring/database/${props.codeId}/export`}
          target="_blank"
          rel="noopener"
        >
          <i class="ti ti-download" aria-hidden="true" /> {t().databaseExport}
        </ButtonLink>
      </Show>
    </span>
  );
}
