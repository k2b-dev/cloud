import { defaultPlugins, defineFibel } from "@k2b/fibel";
import { agentSkillsPlugin, assistantPlugin, imprintPlugin, mcpPlugin, providerFromEnv } from "@k2b/fibel/plugins";
import { cloudSitePlugin } from "./plugins/cloud-site";
import { docsPages } from "./src/docs/pages";
import { siteFooterLinks, siteHeader, siteLocales, siteTheme, siteUrl } from "./src/site-config";
import { uiPages } from "./src/ui/pages";

const assistantPlugins = process.env.FIBEL_AI_MODEL?.trim()
  ? [
      assistantPlugin({
        provider: providerFromEnv(),
        launcherLabel: "Ask Cloud",
        systemPrompt: `
          Cloud is an open-source application platform for building and
          operating applications on the user's own infrastructure.
          The current documentation area is {{currentCollectionLabel}}:
          {{currentCollectionDescription}}.
          Answer only questions about Cloud, its APIs, operation, and its
          shared UI components. Use the documentation tools for detailed,
          procedural, configuration, API, code, or exact-behavior claims.
          Prefer concise, practical answers and clearly state when the
          documentation does not contain the requested information.
        `,
      }),
    ]
  : [];

export default defineFibel({
  title: "Cloud",
  description: "Cloud is an open-source application platform that runs on your infrastructure.",
  siteUrl,
  collections: [
    {
      id: "apps",
      label: "Apps",
      description: "Cloud applications and companion apps, their product boundaries, and their integration.",
      content: "apps-content",
      path: "/apps",
    },
    {
      id: "docs",
      label: "Docs",
      description: "Developer documentation for building and operating Cloud applications.",
      content: "docs",
      path: "/docs",
    },
    {
      id: "ui",
      label: "UI",
      description: "Portable @k2b/ui components and Cloud-specific integrations.",
      content: "ui-content",
      path: "/ui",
    },
  ],
  defaultCollection: "docs",
  assets: "assets",
  locales: siteLocales,
  defaultLocale: "en",
  routing: {
    basePath: "",
    internalPath: "/_fibel",
    assetsPath: "/assets",
  },
  seo: {
    favicon: "/assets/logo.svg",
  },
  theme: siteTheme,
  header: siteHeader,
  footerLinks: [...siteFooterLinks],
  pages: [...docsPages, ...uiPages],
  plugins: [
    ...defaultPlugins(),
    mcpPlugin(),
    agentSkillsPlugin({ directory: "agent-skills" }),
    ...assistantPlugins,
    imprintPlugin({ url: "https://impressum.k2b.dev" }),
    cloudSitePlugin(
      [
        "homepage.css",
        "docs-overview.css",
        "generated/cloud-ui.css",
        "ui-catalog.css",
      ],
      { preloadDisplayFont: true },
    ),
  ],
});
