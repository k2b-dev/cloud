/** Small enough to inline: no render-blocking stylesheet request on the first visit. */
export const SITE_CSS = `
:root{color-scheme:light dark;--ink:#1f1a14;--paper:#fbf7f0;--accent:#8a4b12}
@media (prefers-color-scheme:dark){:root{--ink:#f3ece2;--paper:#1b1712;--accent:#e2a565}}
*{box-sizing:border-box}
body{margin:0;font:1.0625rem/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--paper)}
header,main{max-width:40rem;margin:0 auto;padding:1rem 1.25rem}
header{display:flex;align-items:center;justify-content:space-between}
a{color:var(--accent);padding:.75rem 0;display:inline-block}
h1{font-size:2rem;line-height:1.2;margin:.5rem 0 1rem}
h2{font-size:1.25rem;margin:2rem 0 .5rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1.5rem;margin:0}
dd{margin:0}
address{font-style:normal}
.share{margin-top:2rem;min-height:3rem;padding:0 1.25rem;font:inherit;color:var(--paper);background:var(--accent);border:0;border-radius:.5rem;cursor:pointer}
`;

export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48"><circle cx="24" cy="24" r="22" fill="#8a4b12"/><path d="M12 28c4-10 20-10 24 0-8 4-16 4-24 0z" fill="#fbf7f0"/></svg>`;
