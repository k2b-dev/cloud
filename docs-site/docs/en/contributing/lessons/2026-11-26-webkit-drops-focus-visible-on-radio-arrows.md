### WebKit dropped the focus ring of a v2 radio once the arrows moved it

- **What happened:** While building option cards for `Choice`, the keyboard ring of a card was gone in WebKit after the first arrow key. The points of every single `Choice` had the same gap: Tab showed the ring, ArrowRight moved the choice and the ring vanished.
- **Root cause:** WebKit stops matching `:focus-visible` when the arrows move the focus inside a radio group; Chromium keeps it. The v2 rings hung on `:focus-visible` alone.
- **Error class:** A focus ring that trusts the browser's `:focus-visible` heuristic for focus that the browser itself moves (arrow keys in a radio group). The engines disagree there.
- **Guard:** A `Choice` marks a focus the keyboard brought (`data-keyed`, from core's modality through `focusFromKeyboard`) and its rings also follow `:focus` under that mark; a press clears it. `packages/ui/src/v2/form-controls.browser.test.ts` reaches a choice by Tab, moves it with ArrowRight and checks the ring of the point and of the card, and that a press shows none, in Chromium and WebKit.
