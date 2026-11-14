#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/capability.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/* The mounted source stays behind a root-only directory. A startup-only
 * DAC_OVERRIDE reads local Compose bind secrets without changing host ownership.
 * The supervisor receives a private copy and only its four runtime capabilities. */
static void fail(const char *step) { perror(step); exit(126); }
#define REQUIRE(call) do { if ((call) == -1) fail(#call); } while (0)

static void prepare_key(const char *path) {
  char directory[PATH_MAX];
  if (strlen(path) >= sizeof(directory)) { errno = ENAMETOOLONG; fail("runner_key_source"); }
  strcpy(directory, path);
  char *name = strrchr(directory, '/');
  if (path[0] != '/' || !name || !name[1]) { errno = EINVAL; fail("runner_key_source"); }
  *name++ = 0;
  int parent = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  REQUIRE(parent);
  struct stat info;
  REQUIRE(fstat(parent, &info));
  if (info.st_uid != 0 || (info.st_mode & 07777) != 0700) {
    errno = EACCES; fail("runner_key_source_requires_root_private_directory");
  }
  int source = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  REQUIRE(source);
  REQUIRE(close(parent));
  REQUIRE(fstat(source, &info));
  // An encoded app key is under 256 bytes. Bound malformed input before copying.
  if (!S_ISREG(info.st_mode) || info.st_size < 1 || info.st_size > 4096) {
    errno = EINVAL; fail("runner_key_source_requires_regular_key_file");
  }
  char key[4097];
  size_t size = 0;
  for (;;) {
    ssize_t count = read(source, key + size, sizeof(key) - size);
    if (count == -1) { if (errno == EINTR) continue; fail("runner_key_read"); }
    if (!count) break;
    size += count;
    if (size > 4096) { errno = EFBIG; fail("runner_key_source_too_large"); }
  }
  REQUIRE(close(source));
  umask(0077);
  char temporary[] = "/tmp/cloud-runner-key-XXXXXX";
  if (!mkdtemp(temporary)) fail("runner_key_directory");
  char copy[PATH_MAX];
  snprintf(copy, sizeof(copy), "%s/key", temporary);
  int target = open(copy, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0400);
  REQUIRE(target);
  size_t written = 0;
  while (written < size) {
    ssize_t count = write(target, key + written, size - written);
    if (count == -1) { if (errno == EINTR) continue; fail("runner_key_write"); }
    written += count;
  }
  REQUIRE(close(target));
  explicit_bzero(key, sizeof(key));
  REQUIRE(setenv("CLOUD_APP_KEY_FILE", copy, 1));
}

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--help")) {
    puts("Usage: runner-entrypoint COMMAND [ARGS...]\nStage CLOUD_APP_KEY_FILE from a root-owned 0700 directory; exec the supervisor with four capabilities.");
    return 0;
  }
  if (argc < 2 || geteuid() != 0) { errno = EPERM; fail("runner_entrypoint_requires_root_and_command"); }
  const char *file = getenv("CLOUD_APP_KEY_FILE");
  const char *raw = getenv("CLOUD_APP_KEY");
  if (file && *file) {
    if (raw && *raw) { errno = EINVAL; fail("runner_key_sources_must_not_both_be_set"); }
    prepare_key(file);
  }
  // NNP also prevents root exec from recovering DAC_OVERRIDE from the bounding set.
  REQUIRE(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0));
  REQUIRE(prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0));
  unsigned int runtime = (1U << CAP_SETUID) | (1U << CAP_SETGID) | (1U << CAP_KILL) | (1U << CAP_CHOWN);
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3 };
  struct __user_cap_data_struct caps[2] = {{ .effective = runtime, .permitted = runtime }, {0}};
  REQUIRE(syscall(SYS_capset, &header, caps));
  execvp(argv[1], &argv[1]);
  fail("runner_supervisor_exec");
}
