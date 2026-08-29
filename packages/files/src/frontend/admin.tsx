import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { coreSettings } from "@valentinkolb/cloud/services";
import { AdminLayout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../config";
import FilesSettingsForm from "./_components/FilesSettingsForm.island";
import { filesMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const { t } = filesMessages.resolve([getLocale(c)]);
  // Read current values via the typed async API. Cache-aside means subsequent
  // requests that miss Redis hit DB once, then hit Redis. Sub-millisecond.
  // `files.filegate_token` is `kind:"secret"` — never serialized into the
  // SSR'd HTML data-props. The form initializes empty; admin types a new
  // value to change, leaves empty to keep the current stored secret.
  const [filegateUrl, baseHomes, baseGroups, homeDirMode, homeFileMode, groupDirMode, groupFileMode] = await Promise.all([
    coreSettings.get<string>("files.filegate_url"),
    coreSettings.get<string>("files.base_homes"),
    coreSettings.get<string>("files.base_groups"),
    coreSettings.get<string>("files.home_dir_mode"),
    coreSettings.get<string>("files.home_file_mode"),
    coreSettings.get<string>("files.group_dir_mode"),
    coreSettings.get<string>("files.group_file_mode"),
  ]);

  return () => (
    <AdminLayout c={c} title={t.files}>
      <FilesSettingsForm
        initial={{
          "files.filegate_url": filegateUrl ?? "",
          "files.filegate_token": "",
          "files.base_homes": baseHomes ?? "",
          "files.base_groups": baseGroups ?? "",
          "files.home_dir_mode": homeDirMode ?? "",
          "files.home_file_mode": homeFileMode ?? "",
          "files.group_dir_mode": groupDirMode ?? "",
          "files.group_file_mode": groupFileMode ?? "",
        }}
      />
    </AdminLayout>
  );
});
