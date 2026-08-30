type LayoutFooterProps = {
  appName?: string;
  legalLinks: Array<{ label: string; href: string; icon?: string }>;
};

export default function LayoutFooter(props: LayoutFooterProps) {
  return (
    <footer class="hidden shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-1 px-3 py-2 text-xs text-dimmed md:flex">
      {props.legalLinks.map((link) => (
        <a href={link.href} class="flex items-center gap-1 transition-colors hover:text-primary">
          {link.icon && <i class={`${link.icon} text-xs`} />}
          {link.label}
        </a>
      ))}
      {props.appName && (
        <span class="text-zinc-400 dark:text-zinc-600">
          Copyright &copy; {new Date().getFullYear()} {props.appName}
        </span>
      )}
    </footer>
  );
}
