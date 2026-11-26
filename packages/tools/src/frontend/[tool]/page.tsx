import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { readSpeedtestConfig } from "../../api/speedtest";
import { ssr } from "../../config";
import { registryMessages, resolveRegistry } from "../tools/registry";
import { loadWebhookTester } from "../tools/webhook-page-data";
import { toolScreens } from "./screens";

export default ssr<AuthContext>(async (c) => {
  const toolId = c.req.param("toolId");
  if (!toolId) return ssr.error(c, 404);
  const locale = getLocale(c);
  const tool = resolveRegistry(locale).toolById(toolId);
  const labels = registryMessages.resolve([locale]).t;

  if (!tool) return ssr.error(c, 404);

  const speedtestConfig = tool.id === "speedtest" ? await readSpeedtestConfig() : undefined;
  const webhookData = tool.id === "webhooks" ? await loadWebhookTester(c, new URL(c.req.url)) : undefined;
  const breadcrumbs = [{ title: labels.home, href: "/" }, { title: labels.appName, href: "/tools" }, { title: tool.name }];
  // Every tool is its own whole v2 screen: the Tools frame comes with its island.
  const render = toolScreens[tool.id];
  if (!render) return ssr.error(c, 404);
  return () => (
    <Layout c={c} fullWidth ui="v2" title={breadcrumbs}>
      {render({ speedtestConfig, webhookData })}
    </Layout>
  );
});
