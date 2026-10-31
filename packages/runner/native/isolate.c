#define _GNU_SOURCE
#include <errno.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/sched.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/* No setuid bit or file capabilities. Only the trusted supervisor may launch it.
 * Usage: runner-isolate UID EXECUTABLE [ARGS...]. Fail closed on every setup error. */
static void fail(const char *step) { perror(step); _exit(126); }
#define REQUIRE(call) do { if ((call) == -1) fail(#call); } while (0)
#define DENY(nr) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, nr, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
#if defined(__x86_64__)
#define ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported runner architecture
#endif

static void filter(void) {
  struct sock_filter rules[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    /* Also reject the x32 ABI, which shares AUDIT_ARCH_X86_64. */
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
    /* Native escapes still have only filesystem-protected Unix IPC. No IP,
     * packet or netlink path to Core or other replicas. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 1, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socketpair, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EAFNOSUPPORT),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    /* Threads are required by V8; new processes are not. clone3 returns ENOSYS
     * so libc uses the inspectable clone flags rather than bypassing the rule. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_THREAD, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
#ifdef __NR_fork
    DENY(__NR_fork),
#endif
#ifdef __NR_vfork
    DENY(__NR_vfork),
#endif
    DENY(__NR_ptrace), DENY(__NR_process_vm_readv), DENY(__NR_process_vm_writev),
    DENY(__NR_pidfd_getfd), DENY(__NR_io_uring_setup), DENY(__NR_bpf),
    DENY(__NR_perf_event_open), DENY(__NR_userfaultfd), DENY(__NR_keyctl),
    DENY(__NR_unshare), DENY(__NR_setns), DENY(__NR_mount), DENY(__NR_open_by_handle_at),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = { .len = sizeof(rules) / sizeof(rules[0]), .filter = rules };
  REQUIRE(prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program));
}

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--help")) {
    puts("Usage: runner-isolate UID EXECUTABLE [ARGS...] (supervisor root only)");
    return 0;
  }
  char *end = NULL;
  unsigned long uid = argc >= 3 ? strtoul(argv[1], &end, 10) : 0;
  if (geteuid() != 0 || !end || *end || uid < 20000 || uid > 0x7fffffffUL) {
    fputs("runner_isolation_requires_root_and_unique_uid\n", stderr);
    return 126;
  }
  pid_t supervisor = getppid();
  /* Separate sessions also close Linux's cross-UID SIGCONT exception. */
  REQUIRE(setsid());
  REQUIRE(setgroups(0, NULL));
  REQUIRE(setresgid(uid, uid, uid));
  REQUIRE(setresuid(uid, uid, uid));
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3 };
  struct __user_cap_data_struct caps[2] = {{0}, {0}};
  REQUIRE(syscall(SYS_capset, &header, caps));
  REQUIRE(prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0));
  REQUIRE(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0));
  REQUIRE(prctl(PR_SET_DUMPABLE, 0));
  REQUIRE(prctl(PR_SET_PDEATHSIG, SIGKILL));
  if (getppid() != supervisor) _exit(126);
  /* Bun closes unrelated fds too; repeat here before exec as an explicit boundary. */
  REQUIRE(syscall(SYS_close_range, 3U, ~0U, 0));
  umask(0077);
  filter();
  char *empty_env[] = {NULL};
  execve(argv[2], &argv[2], empty_env);
  fail("runner_exec_workerd");
}
