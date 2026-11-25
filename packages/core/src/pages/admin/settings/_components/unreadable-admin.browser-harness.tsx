import SettingsSaveStatus from "@k2b/cloud/ssr/SettingsSaveStatus.island";
import { Button, LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { previewViews } from "../../../../../../../scripts/fixtures/unreadable-admin/views";
import RetentionForm from "../../../../../../gateway-ops/src/observability/retention/RetentionForm.island";
import { openMailContactDirectoryDialog } from "../../../../../../mail/src/frontend/_components/MailContactDirectoryDialog";
import { adminNavFixture } from "../../admin-v2.fixture";
import RetentionDialog from "../../outgoing-mail/RetentionDialog";
import { linuxQuery } from "../../signin/linux-query";
import { LinuxScreen } from "../../signin/SigninScreen";

const params = new URL(location.href).searchParams;
const locale = params.get("locale") ?? "en";
const surface = params.get("surface") ?? "linux";
const views = previewViews(params.get("late") === "true");
const close = () => {
  document.body.dataset.saved = "true";
};
render(
  () => (
    <LocaleProvider locale={locale}>
      {surface === "linux" && (
        // Linux identities are a v2 screen: the v2 scope around it, as AdminLayout ui="v2" puts it on the main area.
        <main class="k2-ui">
          <LinuxScreen
            nav={adminNavFixture("/admin/signin")}
            linux={{ initial: views.linux, state: linuxQuery(locale).parse("").state, after: null }}
          />
        </main>
      )}
      <main class="mx-auto max-w-3xl p-4">
        {surface === "outgoing" && (
          // The retention dialog is a v2 dialog: it lives in a v2 scope and stays open until it saves.
          <div class="k2-ui">
            <RetentionDialog open retention={views.outgoing} onClose={close} onSaved={() => {}} />
          </div>
        )}
        {surface === "logs" && (
          <>
            <SettingsSaveStatus />
            <RetentionForm
              values={{ logs: views.logs.retentionDays, events: 14, rollups: 90 }}
              unreadable={{ logs: views.logs.unreadable }}
            />
          </>
        )}
        {surface === "directory" && (
          <Button onClick={() => void openMailContactDirectoryDialog(views.directory, locale)}>Contact directory</Button>
        )}
      </main>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
