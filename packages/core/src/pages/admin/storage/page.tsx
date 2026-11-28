import { parseStorageBucketId } from "@k2b/cloud/contracts/storage-buckets";
import { type AuthContext, getLocale, getTimeZone } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { storageBucketStore } from "@k2b/cloud/services/storage-buckets/store";
import { AdminLayout, adminNavigation } from "@k2b/cloud/ssr";
import { ssr } from "../../../config";
import { settingsDocumentationHref } from "../settings/documentation";
import { buildEntries } from "../settings/entries";
import { storageAreaMessages } from "./messages";
import type { StorageSelection } from "./StorageScreen";
import StorageScreen from "./StorageScreen.island";

/** Administration › Storage: the default bucket and the further buckets apps can use. `?bucket=` opens one. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const requested = c.req.query("bucket");
  const [items, defaultEntries, documentationBase] = await Promise.all([
    storageBucketStore.list().catch((error: unknown) => {
      console.error("[admin] storage buckets could not be read", error instanceof Error ? error.message : error);
      return null;
    }),
    Promise.all([buildEntries("storage", locale), buildEntries("previews", locale)]).then((groups) => groups.flat()),
    coreSettings.get<string>("app.documentation_url"),
  ]);
  const id = requested === undefined || requested === "new" ? null : parseStorageBucketId(requested);
  const bucket = id ? items?.find((item) => item.id === id) : undefined;
  const selection: StorageSelection =
    requested === undefined
      ? { kind: "none" }
      : requested === "new"
        ? { kind: "new" }
        : bucket
          ? { kind: "bucket", bucket }
          : { kind: "unknown" };
  return () => (
    <AdminLayout c={c} ui="v2" title={storageAreaMessages.resolve([locale]).t.area}>
      <StorageScreen
        nav={adminNavigation(c)}
        items={items}
        selection={selection}
        defaultEntries={defaultEntries}
        documentationHref={settingsDocumentationHref(documentationBase, "storage")}
        timeZone={getTimeZone(c)}
      />
    </AdminLayout>
  );
});
