import { MinimalLayout, type MinimalLayoutProps } from "@k2b/cloud/ssr";
import { Paper } from "@k2b/ui";
import type { JSX } from "solid-js";
import { PAGE_TITLE_ID } from "./AuthorizationParts";

/**
 * The page around every OAuth decision a person sees: no rail, header, or app
 * navigation, only one centered card on the page background. On phones the
 * card is flat (`standalone-card`), so the content uses the full width.
 */
export function AuthorizationPage(props: { c: MinimalLayoutProps["c"]; title: string; children: JSX.Element }) {
  props.c.get("page").title = props.title;
  return (
    <MinimalLayout c={props.c}>
      <main class="flex flex-1 items-center justify-center px-4 py-8 text-primary">
        <Paper as="section" elevated class="standalone-card w-full max-w-md p-6 sm:p-8" aria-labelledby={PAGE_TITLE_ID}>
          {props.children}
        </Paper>
      </main>
    </MinimalLayout>
  );
}
