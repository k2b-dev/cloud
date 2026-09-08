# Sync topic recovery patch

Cloud pins `@k2b/sync` 6.3.2 and applies the adjacent Bun patch during installation.
The patch contains the reviewed upstream topic dead-letter inspection and
consumer-specific recovery implementation, including its shutdown cleanup fix.
It does not republish recovered events to other topic consumers.

The source change is Sync commit `e71bb5b`. No new Sync release is required
to build this Cloud checkout: frozen Bun installs and the application Docker
builds apply this patch. Local repository paths are not dependencies.

Before publishing the Cloud npm library, publish and adopt the corresponding
Sync release, then remove the patch. Bun patches belong to the root project and
are not inherited by downstream consumers installing the Cloud library.

When refreshing the patch, build Sync with its release commands, copy the changed
`index.js`, `index.d.ts`, `src/topic.d.ts`, and `src/sync.d.ts` into the directory
prepared by `bun patch @k2b/sync@6.3.2`, then run `bun patch --commit` for that
directory. Verify the installed package with the Cloud Sync operations integration
test and the upstream topic recovery and mutex lifecycle tests.
