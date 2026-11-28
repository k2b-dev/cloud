import { getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import type { ComponentProps } from "solid-js";
import { pulseMessages } from "../../messages";
import DeletingScreen from "../screens/DeletingScreen.island";
import type { DeletingPageData } from "./page-data";

/** What this page needs of the page's context: its locale and its layout. */
type PageContext = Parameters<typeof getLocale>[0] & ComponentProps<typeof Layout>["c"];

/** Every address of a base in deletion shows its admins the same page: the deletion and the way on. */
export const deletingPage = (c: PageContext, data: DeletingPageData) => {
  const { t } = pulseMessages.resolve([getLocale(c)]);
  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[{ title: t.start, href: "/" }, { title: t.appName, href: "/app/pulse" }, { title: data.base.name }]}
    >
      <DeletingScreen nav={data.nav} base={data.base} />
    </Layout>
  );
};
