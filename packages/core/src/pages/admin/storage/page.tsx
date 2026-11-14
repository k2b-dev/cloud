import { parseStorageBucketId } from "@k2b/cloud/contracts/storage-buckets";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { storageBucketStore } from "@k2b/cloud/services/storage-buckets/store";
import { ssr } from "../../../config";
import { buildEntries } from "../settings/entries";
import { type StorageSelection, StorageView } from "./view";

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
    <StorageView
      c={c}
      locale={locale}
      items={items}
      selection={selection}
      defaultEntries={defaultEntries}
      documentationBase={documentationBase}
    />
  );
});
