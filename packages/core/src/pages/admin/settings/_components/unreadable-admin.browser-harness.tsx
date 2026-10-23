import { Button, LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { previewViews } from "../../../../../../../scripts/fixtures/unreadable-admin/views";
import { DatabaseSettingsForm, StorageSettingsForm } from "../../../../../../assistant/src/artifacts/AdminSettings";
import { LogRetentionDialog } from "../../../../../../gateway-ops/src/observability/logs/_components/LogFilterBar";
import { openMailContactDirectoryDialog } from "../../../../../../mail/src/frontend/_components/MailContactDirectoryDialog";
import { RetentionDialog } from "../../outgoing-mail/SendLog";
import LinuxIdentityPanel from "./LinuxIdentityPanel.island";

const params = new URL(location.href).searchParams;
const locale = params.get("locale") ?? "en";
const surface = params.get("surface") ?? "storage";
const views = previewViews(params.get("late") === "true");
const close = () => {
  document.body.dataset.saved = "true";
};
render(
  () => (
    <LocaleProvider locale={locale}>
      <main class="mx-auto max-w-3xl p-4">
        {surface === "storage" && <StorageSettingsForm current={views.storage} close={close} />}
        {surface === "database" && <DatabaseSettingsForm current={views.database} close={close} />}
        {surface === "linux" && <LinuxIdentityPanel initial={views.linux} />}
        {surface === "outgoing" && <RetentionDialog retention={views.outgoing} close={close} onSaved={() => {}} />}
        {surface === "logs" && (
          <LogRetentionDialog retentionDays={views.logs.retentionDays} unreadable={views.logs.unreadable} close={close} />
        )}
        {surface === "directory" && (
          <Button onClick={() => void openMailContactDirectoryDialog(views.directory, locale)}>Contact directory</Button>
        )}
      </main>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
