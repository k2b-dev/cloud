import type { listLegalLinks } from "@valentinkolb/cloud";
import LanguageSwitch from "./LanguageSwitch.island";

export default function AuthFooter(props: { links: Awaited<ReturnType<typeof listLegalLinks>> }) {
  return (
    <footer class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-dimmed">
      <span>
        {props.links.map((link, i) => (
          <>
            {i > 0 ? " · " : null}
            <a href={link.href} target="_blank" rel="noopener" class="hover:text-primary">
              {link.label}
            </a>
          </>
        ))}
      </span>
      <LanguageSwitch />
    </footer>
  );
}
