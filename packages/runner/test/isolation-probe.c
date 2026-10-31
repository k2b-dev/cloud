#define _GNU_SOURCE
/* Trusted native probe execs workerd in-place after attacks. It therefore has
 * exactly workerd's PID, session, UID/GID, seccomp policy, capabilities and fds. */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/capability.h>
#include <sys/syscall.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ptrace.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/uio.h>
#include <unistd.h>

static void check(int ok, const char *name) {
  if (!ok) { fprintf(stderr, "isolation_probe_failed: %s (%s)\n", name, strerror(errno)); _exit(125); }
}
static void unreadable(const char *path) {
  int fd = open(path, O_RDONLY);
  check(fd == -1 && (errno == EACCES || errno == EPERM), path);
}
static void proc_unreadable(int pid) {
  char path[128];
  snprintf(path, sizeof(path), "/proc/%d/environ", pid); unreadable(path);
  snprintf(path, sizeof(path), "/proc/%d/mem", pid); unreadable(path);
  snprintf(path, sizeof(path), "/proc/%d/fd/0", pid); unreadable(path);
  errno = 0;
  check(ptrace(PTRACE_ATTACH, pid, 0, 0) == -1 && errno == EPERM, "ptrace");
  char data;
  struct iovec local = { .iov_base = &data, .iov_len = 1 };
  struct iovec remote = { .iov_base = (void *)1, .iov_len = 1 };
  check(process_vm_readv(pid, &local, 1, &remote, 1, 0) == -1 && errno == EPERM, "process_vm_readv");
  int signals[] = {0, SIGUSR1, SIGCONT};
  for (unsigned i = 0; i < sizeof(signals) / sizeof(signals[0]); ++i)
    check(kill(pid, signals[i]) == -1 && errno == EPERM, "signal");
}
int main(int argc, char **argv) {
  check(argc >= 5 && !strcmp(argv[1], "serve"), "workerd arguments");
  extern char **environ;
  check(environ[0] == NULL, "empty environment");
  for (int fd = 3; fd < 64; ++fd) check(fcntl(fd, F_GETFD) == -1 && errno == EBADF, "no inherited descriptors");
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3 };
  struct __user_cap_data_struct caps[2] = {{0}, {0}};
  check(syscall(SYS_capget, &header, caps) == 0, "capget");
  for (int i = 0; i < 2; ++i)
    check(!caps[i].effective && !caps[i].permitted && !caps[i].inheritable, "no capabilities");
  int supervisor = getppid();
  char targets[PATH_MAX], report[PATH_MAX], key[PATH_MAX], socket_path[108], sibling_config[PATH_MAX];
  snprintf(targets, sizeof(targets), "/tmp/runner-isolation-%d.targets", supervisor);
  FILE *file = fopen(targets, "r");
  check(file != NULL, "targets");
  int sibling = 0;
  check(fscanf(file, "%d", &sibling) == 1, "sibling pid");
  if (sibling) {
    check(fscanf(file, "%4095s %107s %4095s", key, socket_path, sibling_config) == 3, "attack targets");
    check(getuid() >= 20000 && getuid() == geteuid(), "separate uid");
    check(getgroups(0, NULL) == 0, "no supplementary groups");
    check(getsid(0) != getsid(supervisor) && getsid(0) != getsid(sibling), "separate sessions");
    unreadable(key); proc_unreadable(supervisor); proc_unreadable(sibling); unreadable(sibling_config);
    check(setuid(0) == -1 && errno == EPERM, "cannot regain root");
    check(socket(AF_INET, SOCK_STREAM, 0) == -1 && errno == EAFNOSUPPORT, "no IPv4");
    check(socket(AF_INET6, SOCK_STREAM, 0) == -1 && errno == EAFNOSUPPORT, "no IPv6");
    check(fork() == -1 && errno == EPERM, "no subprocess escape");
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    check(fd != -1, "Unix socket");
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    strcpy(address.sun_path, socket_path);
    check(connect(fd, (struct sockaddr *)&address, sizeof(address)) == -1 && errno == EACCES, "sibling socket");
    close(fd);
  }
  fclose(file);
  snprintf(report, sizeof(report), "/tmp/runner-isolation-%d.%s", supervisor, sibling ? "passed" : "victim");
  file = fopen(report, "w"); check(file != NULL, "report");
  fprintf(file, "%d %s\n", getpid(), argv[argc - 1]); fclose(file);
  char executable[PATH_MAX];
  /* argv[0] is the absolute probe path supplied by WorkerdEngine. */
  check(strlen(argv[0]) + 1 < sizeof(executable), "path length");
  strcpy(executable, argv[0]);
  char *name = strrchr(executable, '/'); check(name != NULL, "absolute path");
  strcpy(name + 1, "workerd");
  argv[0] = executable;
  execv(executable, argv);
  check(0, "exec workerd");
}
