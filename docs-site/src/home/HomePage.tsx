import type { ThemeMode } from "@k2b/fibel";
import HomeHeader from "./HomeHeader.island";
import HomeShortcuts from "./HomeShortcuts.client";

function GitHubIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M9 19c-4.3 1.4 -4.3 -2.5 -6 -3m12 5v-3.5c0 -1 .1 -1.4 -.5 -2c2.8 -.3 5.5 -1.4 5.5 -6a4.6 4.6 0 0 0 -1.3 -3.2a4.2 4.2 0 0 0 -.1 -3.2s-1.1 -.3 -3.5 1.3a12.3 12.3 0 0 0 -6.2 0c-2.4 -1.6 -3.5 -1.3 -3.5 -1.3a4.2 4.2 0 0 0 -.1 3.2a4.6 4.6 0 0 0 -1.3 3.2c0 4.6 2.7 5.7 5.5 6c-.6 .6 -.6 1.2 -.5 2v3.5" />
    </svg>
  );
}

type HomePageProps = {
  theme: ThemeMode;
  themeCookieName: string;
};

export default function HomePage(props: HomePageProps) {
  return (
    <>
      <HomeHeader initialTheme={props.theme} themeCookieName={props.themeCookieName} />
      <main class="cloud-home">
        <section class="cloud-hero">
          <div class="cloud-shell cloud-hero-grid">
            <div class="cloud-hero-copy">
              <h1>
                The open-source
                <br />
                application platform
                <br />
                that runs on
                <br />
                your infrastructure.
              </h1>
              <p class="cloud-lead">
                Cloud gives every application identity, permissions, product UI, data, automation, and operations. Use the building blocks
                you need and keep each service independent.
              </p>
              <div class="cloud-actions">
                <a class="cloud-btn cloud-btn-primary" href="/en/docs/overview">
                  Read the developer overview
                </a>
                <a class="cloud-btn" href="https://github.com/ValentinKolb/cloud">
                  <GitHubIcon />
                  Browse the source
                </a>
              </div>
              <p class="cloud-stack">
                <span>AGPL-3.0-or-later</span>
                <span>Bun</span>
                <span>Hono</span>
                <span>SolidJS</span>
                <span>Postgres</span>
                <span>Valkey</span>
              </p>
            </div>
            <figure class="cloud-artifact cloud-request-trace">
              <figcaption class="cloud-request-trace-head">
                <span>gateway request</span>
                <span>cloud.example</span>
              </figcaption>
              <div class="cloud-request-canvas">
                <div class="cloud-request-entry">
                  <span>GET</span>
                  <code>/api/inventory/health</code>
                  <b>200</b>
                </div>

                <div class="cloud-registry-record">
                  <span class="cloud-trace-label">longest prefix match</span>
                  <dl>
                    <div>
                      <dt>appId</dt>
                      <dd>inventory</dd>
                    </div>
                    <div>
                      <dt>routePrefix</dt>
                      <dd>/api/inventory</dd>
                    </div>
                    <div>
                      <dt>baseUrl</dt>
                      <dd>http://inventory:3000</dd>
                    </div>
                  </dl>
                </div>

                <div class="cloud-runtime-response">
                  <div class="cloud-runtime-response-head">
                    <span>inventory</span>
                    <span>
                      <i aria-hidden="true" /> registered
                    </span>
                  </div>
                  <pre>
                    <code>{`{ "status": "ok" }`}</code>
                  </pre>
                </div>
              </div>
              <div class="cloud-request-events">
                <span>gateway-router</span>
                <span>route.match</span>
                <span>inventory</span>
                <b>24 ms</b>
              </div>
            </figure>
          </div>
        </section>

        <section class="cloud-dayone">
          <div class="cloud-shell">
            <div class="cloud-dayone-head">
              <h2>A working platform from day one.</h2>
              <p>Start with applications for everyday work. Build your own on the same foundation.</p>
            </div>
            <div class="cloud-product-stage">
              <div class="cloud-product-window cloud-product-mail" aria-hidden="true">
                <div class="cloud-product-window-head">
                  <b>Mail</b>
                  <span>Inbox</span>
                </div>
                <div class="cloud-mail-row is-active">
                  <i />
                  <span>
                    <b>Product update</b>
                    <small>Review the latest changes</small>
                  </span>
                </div>
                <div class="cloud-mail-row">
                  <i />
                  <span>
                    <b>Inventory</b>
                    <small>3 records need attention</small>
                  </span>
                </div>
                <div class="cloud-mail-row">
                  <i />
                  <span>
                    <b>Team notes</b>
                    <small>Shared with Operations</small>
                  </span>
                </div>
              </div>
              <div class="cloud-product-window cloud-product-main">
                <div class="cloud-product-window-head">
                  <b>Grids</b>
                  <span>Inventory / All records</span>
                  <i aria-hidden="true" />
                </div>
                <div class="cloud-product-toolbar">
                  <span>18 records</span>
                  <span>Updated now</span>
                  <b>New record</b>
                </div>
                <div class="cloud-product-table" aria-hidden="true">
                  <div class="cloud-product-table-head">
                    <span>Item</span>
                    <span>Owner</span>
                    <span>Status</span>
                  </div>
                  <div>
                    <b>Studio display</b>
                    <span>Design</span>
                    <i>In use</i>
                  </div>
                  <div>
                    <b>Conference camera</b>
                    <span>Operations</span>
                    <i>Ready</i>
                  </div>
                  <div>
                    <b>Field notebook</b>
                    <span>Research</span>
                    <i>In use</i>
                  </div>
                </div>
              </div>
              <div class="cloud-product-window cloud-product-contract" aria-hidden="true">
                <div class="cloud-product-window-head">
                  <b>Approvals</b>
                  <span>connected</span>
                </div>
                <pre>
                  <code>
                    <em>id</em>: "approvals"{`\n`}
                    <em>path</em>: "/app/approvals"{`\n`}
                    <em>permissions</em>: ["review"]
                  </code>
                </pre>
              </div>
            </div>
            <div class="cloud-dayone-principles">
              <div>
                <b>Useful applications</b>
                <span>Ready for everyday work.</span>
              </div>
              <div>
                <b>Shared platform</b>
                <span>Identity, UI, data, and operations.</span>
              </div>
              <div>
                <b>Independent services</b>
                <span>Your domain, deployment, and release.</span>
              </div>
            </div>
          </div>
        </section>

        <section class="cloud-request">
          <div class="cloud-shell cloud-contract-grid">
            <div class="cloud-contract-copy">
              <h2>One declaration connects your application.</h2>
              <p>Define its identity, routes, and appearance. Cloud connects it to the shared platform.</p>
              <ul class="cloud-contract-points">
                <li>Identity and routes</li>
                <li>Shared platform services</li>
                <li>Independent runtime and release</li>
              </ul>
            </div>
            <figure class="cloud-artifact cloud-code cloud-app-contract-code">
              <figcaption class="cloud-code-head">
                <span>src/config.ts</span>
                <span class="cloud-artifact-note">one application contract</span>
              </figcaption>
              <pre>
                <code>
                  <span class="hl-keyword">import</span> {`{ defineApp }`} <span class="hl-keyword">from</span>{" "}
                  <span class="hl-string">"@valentinkolb/cloud"</span>;{`\n\n`}
                  <span class="hl-keyword">export const</span> app <span class="hl-operator">=</span> defineApp({`{`}
                  {`\n  `}id: <span class="hl-string">"my-app"</span>,{`\n  `}name: <span class="hl-string">"My App"</span>,{`\n  `}
                  appearance: {`{`} accent: <span class="hl-string">"#1b5fd9"</span> {`}`},{`\n  `}basePath:{" "}
                  <span class="hl-string">"/app/my-app"</span>,{`\n  `}routes: [{`\n    `}
                  <span class="hl-string">"/api/my-app"</span>,{`\n    `}
                  <span class="hl-string">"/app/my-app"</span>,{`\n  `}],{`\n`}
                  {`}`});{`\n\n`}
                  <span class="hl-keyword">export const</span> {`{ ssr, plugin }`} <span class="hl-operator">=</span> app;
                </code>
              </pre>
              <div class="cloud-contract-status">
                <span>registered</span>
                <span>routed</span>
                <span>ready</span>
              </div>
            </figure>
          </div>
        </section>

        <section class="cloud-boundary">
          <div class="cloud-shell">
            <div class="cloud-facts-head">
              <h2>The platform at a glance.</h2>
              <p>What Cloud provides, what applications own, and what operators run.</p>
            </div>
            <div class="cloud-factsheet">
              <section class="cloud-fact cloud-fact-apps">
                <h3>Applications included</h3>
                <ul>
                  <li>Mail</li>
                  <li>Notebooks</li>
                  <li>Spaces</li>
                  <li>Grids</li>
                  <li>Files</li>
                  <li>Contacts</li>
                  <li>Assistant</li>
                </ul>
                <a href="/en/apps">Explore all applications →</a>
              </section>
              <section class="cloud-fact">
                <h3>Shared platform</h3>
                <ul>
                  <li>Identity and access</li>
                  <li>Gateway and application registry</li>
                  <li>UI, settings, and administration</li>
                  <li>Jobs, workflows, and notifications</li>
                  <li>Logging, tracing, and health</li>
                </ul>
              </section>
              <section class="cloud-fact">
                <h3>Every application owns</h3>
                <ul>
                  <li>Domain and permissions</li>
                  <li>Routes and API</li>
                  <li>Durable data</li>
                  <li>Image, version, and release</li>
                </ul>
              </section>
              <section class="cloud-fact">
                <h3>Reference stack</h3>
                <dl>
                  <div>
                    <dt>Runtime</dt>
                    <dd>Bun · Hono</dd>
                  </div>
                  <div>
                    <dt>Interface</dt>
                    <dd>SolidJS SSR · @k2b/ui</dd>
                  </div>
                  <div>
                    <dt>State</dt>
                    <dd>Postgres · Valkey</dd>
                  </div>
                  <div>
                    <dt>Deployment</dt>
                    <dd>Independent services</dd>
                  </div>
                </dl>
              </section>
              <footer class="cloud-factsheet-foot">
                <p>
                  <span>AGPL-3.0-or-later</span>
                  <span>TypeScript packages</span>
                  <span>Open HTTP boundary</span>
                </p>
                <nav aria-label="Platform resources">
                  <a href="/en/docs/overview">Docs →</a>
                  <a href="/en/ui">UI components →</a>
                  <a href="https://github.com/ValentinKolb/cloud">Source →</a>
                </nav>
              </footer>
            </div>
          </div>
        </section>
      </main>
      <footer class="cloud-home-footer">
        <div class="cloud-shell cloud-home-footer-inner">
          <span>Cloud</span>
          <nav aria-label="Footer navigation">
            <a href="https://github.com/ValentinKolb/cloud">Source</a>
            <a href="https://github.com/ValentinKolb/cloud/blob/main/LICENSE">AGPL-3.0</a>
            <a href="https://impressum.k2b.dev">Imprint</a>
          </nav>
        </div>
      </footer>
      <HomeShortcuts />
    </>
  );
}
