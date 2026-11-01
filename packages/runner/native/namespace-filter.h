#ifndef CLOUD_NAMESPACE_FILTER_H
#define CLOUD_NAMESPACE_FILTER_H
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <stddef.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#if defined(__x86_64__)
#define JOB_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define JOB_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported job architecture
#endif
/* Installed after trusted namespace setup, before either parser or fake executor.
 * Descendants can fork/exec ordinary processes and threads, but cannot widen isolation. */
static int constrain_namespaces(void) {
  struct sock_filter rules[] = {
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,JOB_AUDIT_ARCH,1,0),
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
#if defined(__x86_64__)
    BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,0x40000000,0,1),
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
#endif
#define DENY_JOB_SYSCALL(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_##n,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM)
    DENY_JOB_SYSCALL(unshare), DENY_JOB_SYSCALL(setns), DENY_JOB_SYSCALL(mount),
    DENY_JOB_SYSCALL(umount2), DENY_JOB_SYSCALL(pivot_root),
    DENY_JOB_SYSCALL(fsopen), DENY_JOB_SYSCALL(fsconfig), DENY_JOB_SYSCALL(fsmount),
    DENY_JOB_SYSCALL(move_mount), DENY_JOB_SYSCALL(open_tree), DENY_JOB_SYSCALL(mount_setattr),
#undef DENY_JOB_SYSCALL
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_clone3,0,1),
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|ENOSYS),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_clone,0,3),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])),
    BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNET|CLONE_NEWNS|CLONE_NEWIPC|CLONE_NEWUTS|CLONE_NEWCGROUP,0,1),
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program={.len=sizeof(rules)/sizeof(rules[0]),.filter=rules};
  return prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program);
}
#endif
