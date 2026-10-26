### Pairing survives incidental gestures and uncertain requests

Multi-step enrollment must close only through explicit controls. Use the
existing `dialogCore` option `cancelBehavior: "ignore"` for backdrop, Escape
and sheet dismissal; avoid a synthetic Back entry when it would discard the
flow. Keep the saved enrollment key when a request is interrupted. Read the
server's status before retrying a claim: only `pending` allows a new claim.
Guard: Cloud Login's `pairing.browser.test.ts` checks outside taps, Escape,
dragging, interrupted claims and resumption in Chromium and WebKit.
Its status-bar test closes pairing through the explicit button. Loading-state
tests hold mocked requests with a controlled promise until after the loading
assertion; short sleeps can finish out of order under host load. Guard:
`Clouds.behavior.test.tsx` ([#1780](https://github.com/k2b-dev/cloud/issues/1780)).
For a timed interaction guard, pause the browser clock before rendering and
advance it explicitly; setup itself can outlast the guard's interval. Guard:
`Approvals.browser.test.ts` ([#1785](https://github.com/k2b-dev/cloud/issues/1785)).

