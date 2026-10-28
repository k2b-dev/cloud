### An integration fixture misses a new account relation

- **What happened:** Files integration tests failed after account identity lookup started reading durable personal-group ownership.
- **Root cause:** The isolated account fixtures mirrored the previous schema and represented ownership only through a mutable primary-group assignment.
- **Error class:** Dependent schema fixtures drift from shared services
- **Guard:** The Files fixtures run the real Core POSIX migration, including ownership constraints and triggers (main #1951). The service integration test checks that the real trigger records ownership and verifies that removing the owner's POSIX row still hides the personal group while retaining an ordinary group area. Existing real Filegate cases exercise the same account lookup. Tracked in #1948.
