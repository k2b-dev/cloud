import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { CUSTOM_APP_REFERENCE, CustomAppDefinitionSchema } from "../../custom-apps/contracts";
import "../_components/ssr-test-plugin";

const { CustomAppPageLayout } = await import("./PageLayout");

test("renders the known record parameter in the published sidebar link", () => {
  const definition = CustomAppDefinitionSchema.parse({
    ...CUSTOM_APP_REFERENCE.example,
    pages: CUSTOM_APP_REFERENCE.example.pages.map((page, index) =>
      index === 1 ? { ...page, navigation: { ...page.navigation, visible: true, recordId: "REC001" } } : page,
    ),
  });
  const target = definition.pages[1]!;
  const html = renderToString(() =>
    createComponent(CustomAppPageLayout, {
      definition,
      page: definition.pages[0]!,
      appId: "APP001",
      renderBlock: () => "Content",
    }),
  );
  expect(html).toContain(`href="/apps/APP001/${target.id}?${target.record!.id.path}=REC001"`);
  expect(html).not.toContain(`href="/apps/APP001/${target.id}"`);
});
