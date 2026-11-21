import { CodeDatabaseDelete, CodeDatabaseStatus } from "@k2b/cloud/ssr/code-page";
import { ButtonLink, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import type { CodeDatabaseUsage } from "../../../code/database";
import { codeAdminMessages } from "./messages";

/** Shared controls for the detail island and unused-database table. */
export default function CodeDatabaseControls(props: { codeId: string; database: CodeDatabaseUsage; actionsOnly?: boolean }) {
  const locale = useLocale();
  return (
    <Show when={props.actionsOnly} fallback={<CodeDatabaseStatus codeId={props.codeId} database={props.database} />}>
      <span class="inline-grid w-32 gap-2">
        <ButtonLink
          size="sm"
          variant="secondary"
          href={`/api/code/authoring/database/${props.codeId}/export`}
          target="_blank"
          rel="noopener"
        >
          {codeAdminMessages.resolve([locale()]).t.databaseExport}
        </ButtonLink>
        <Show when={props.database.unused?.canDelete}>
          <CodeDatabaseDelete codeId={props.codeId} unused={props.database.unused!} />
        </Show>
      </span>
    </Show>
  );
}
