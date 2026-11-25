import type { JSX } from "solid-js";

/**
 * The page template of the sign-in pages: the v2 scope on the page, its workspace centred in a box of 480 px on a
 * computer and filling the screen on a phone. It is the template, not a screen, so it sizes the box like a body does
 * (`AuthFrame` is the v2 screen inside it).
 *
 * k2b-ui gap: v2 has no frame for a page without an app (sign-in, consent); Cloud's `Layout ui="v2"` and
 * `MinimalLayout` do not cover it, so the template sets the scope and the box itself.
 */
export default function AuthPage(props: { children: JSX.Element; /** The consent page names the version of the documents it shows. */ legalVersion?: string }) {
  return (
    <main class="k2-ui flex min-h-svh items-stretch justify-center md:items-center md:p-6" data-legal-version={props.legalVersion}>
      <div class="flex h-svh w-full md:h-[min(46rem,calc(100svh-3rem))] md:max-w-[30rem]">{props.children}</div>
    </main>
  );
}
