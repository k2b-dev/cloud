import { For } from "solid-js";

type DocsOverviewPageProps = {
  locale: string;
};

type DocsLink = {
  title: string;
  description: string;
  path: string;
};

const startingPoints: DocsLink[] = [
  {
    title: "Build your first application",
    description: "Run a small service, register it, and handle one request.",
    path: "/build/getting-started",
  },
  {
    title: "Understand the platform",
    description: "See what Cloud owns and what remains inside an application.",
    path: "/overview",
  },
  {
    title: "Find an API",
    description: "Match an application task to its public import and reference.",
    path: "/building-blocks",
  },
];

const documentationGroups = [
  {
    title: "Accounts & sign-in",
    description: "Configure people, login methods and account maintenance.",
    links: [
      { label: "Choose your setup", path: "/accounts" },
      { label: "Account types", path: "/operations/account-categories" },
      { label: "FreeIPA", path: "/operations/freeipa" },
      { label: "App sign-in", path: "/accounts/app-sign-in" },
    ],
  },
  {
    title: "Build",
    description: "Create and connect an application.",
    links: [
      { label: "Application overview", path: "/build" },
      { label: "Define an application", path: "/build/define-app" },
      { label: "Application lifecycle", path: "/build/lifecycle" },
      { label: "Routes and discovery", path: "/build/routing" },
    ],
  },
  {
    title: "Requests and data",
    description: "Own the request from input to persistence.",
    links: [
      { label: "Server requests", path: "/server" },
      { label: "Identity and access", path: "/identity" },
      { label: "Application data", path: "/data" },
      { label: "Typed HTTP APIs", path: "/server/http" },
    ],
  },
  {
    title: "Platform building blocks",
    description: "Adopt shared capabilities when the application needs them.",
    links: [
      { label: "Platform services", path: "/platform" },
      { label: "Automation", path: "/automation" },
      { label: "Frontend", path: "/frontend" },
      { label: "AI", path: "/ai" },
    ],
  },
  {
    title: "Ship and look up",
    description: "Develop, operate, and verify public contracts.",
    links: [
      { label: "Operations", path: "/operations" },
      { label: "API reference", path: "/reference" },
      { label: "Public API surface", path: "/reference/api-surface" },
      { label: "Document core changes", path: "/contributing/document-cloud-core-changes" },
      { label: "UI catalog", href: "/ui" },
    ],
  },
];

export function DocsOverviewPage(props: DocsOverviewPageProps) {
  const docsBase = `/${props.locale}/docs`;
  const docsHref = (path: string) => `${docsBase}${path}`;

  return (
    <article class="docs-overview">
      <header class="docs-overview-hero">
        <div>
          <p class="docs-overview-kicker">Cloud developer documentation</p>
          <h1>Build applications on Cloud.</h1>
        </div>
        <p class="docs-overview-lead">
          Start with a working service, then use the platform APIs your
          application needs. Cloud handles shared concerns; your application
          keeps its domain logic and release cycle.
        </p>
      </header>

      <section class="docs-overview-start" aria-labelledby="docs-start-title">
        <header>
          <p>Start here</p>
          <h2 id="docs-start-title">Choose the next useful step.</h2>
        </header>
        <ol>
          <For each={startingPoints}>
            {(entry, index) => (
              <li>
                <a href={docsHref(entry.path)}>
                  <span class="docs-overview-index">
                    {String(index() + 1).padStart(2, "0")}
                  </span>
                  <span>
                    <strong>{entry.title}</strong>
                    <small>{entry.description}</small>
                  </span>
                  <span aria-hidden="true">→</span>
                </a>
              </li>
            )}
          </For>
        </ol>
      </section>

      <section
        class="docs-overview-directory"
        aria-labelledby="docs-directory-title"
      >
        <header>
          <p>Browse</p>
          <h2 id="docs-directory-title">Find the contract you need.</h2>
        </header>
        <div>
          <For each={documentationGroups}>
            {(group) => (
              <section>
                <h3>{group.title}</h3>
                <p>{group.description}</p>
                <ul>
                  <For each={group.links}>
                    {(link) => (
                      <li>
                        <a
                          href={
                            "href" in link
                              ? `/${props.locale}${link.href}`
                              : docsHref(link.path)
                          }
                        >
                          {link.label}
                        </a>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            )}
          </For>
        </div>
      </section>

      <footer class="docs-overview-source">
        <p>
          Prefer source text? Append <code>.md</code> to any documentation URL.
        </p>
        <nav aria-label="Documentation source formats">
          <a href={`/${props.locale}/docs/llms.txt`}>llms.txt</a>
          <a href={`/${props.locale}/docs/llms-full.txt`}>llms-full.txt</a>
        </nav>
      </footer>
    </article>
  );
}
