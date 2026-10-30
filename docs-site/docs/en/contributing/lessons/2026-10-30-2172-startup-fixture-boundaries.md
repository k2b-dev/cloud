### Startup fixtures cross CLI, image, and isolated test boundaries

- **What happened:** CI rejected the new documentation section, the PWA image missed a fixture dependency, packed setup could not resolve its startup import, CLI commands loaded server clients, and an isolated native-pool test read the snapshot before initialization.
- **Root cause:** The foundation assumed that every fixture consumer had the repository package aliases, all fixture files, and a previously initialized process. An eager re-export loaded server modules even without test targets.
- **Error class:** Startup dependencies escape their process and packaging boundary.
- **Guard:** The existing documentation check, PWA image build, packed-consumer runtime check, CLI module-isolation test, and native-pool integration test cover these boundaries. `scripts/fixtures/platform-lazy.test.ts` checks the preload without configured targets.
