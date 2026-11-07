### Moving Pulse to the app menu must keep personal choices

- **What happened:** Pulse should open from the app menu instead of the rail by default, without hiding it for people who had chosen to show or pin it.
- **Root cause:** A navigation section change can be implemented as a visibility rewrite that overrides saved preferences and pins.
- **Error class:** A navigation default overrides a personal choice.
- **Guard:** Tests: Pulse `config.test.ts` guards its `more` declaration; Cloud `rail-navigation.test.ts` checks explicit visibility and pins when the default is hidden.
