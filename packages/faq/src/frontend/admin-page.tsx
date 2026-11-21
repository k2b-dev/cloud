import type { AuthContext } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { faqService } from "../service";
import FaqAdmin from "./_components/FaqAdmin";

export default ssr<AuthContext>(async (c) => {
  const entries = (await faqService.entry.list()).items;

  return () => (
    <AdminLayout c={c} title="FAQ">
      <FaqAdmin entries={entries} />
    </AdminLayout>
  );
});
