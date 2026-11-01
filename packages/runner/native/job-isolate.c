#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/capability.h>
#include <linux/sched.h>
#include <sched.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include "namespace-filter.h"
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

/* No setuid or file capabilities. The supervisor reserves a disjoint UID range until reaped.
 * Only stdio reaches a credential-free init in new user/PID/mount/network namespaces. */
static void fail(const char *step) { perror(step); _exit(126); }
#define REQUIRE(x) do { if ((x) == -1) fail(#x); } while (0)
static volatile sig_atomic_t cancelled, init_pid;
static void cancel_job(int number) {
  (void)number;
  cancelled=1;
  if(init_pid>0)kill(init_pid,SIGKILL);
}
struct arguments { char **command; int ready; int writer; const char *tmpbytes; sigset_t signal_mask; };
static int child(void *pointer) {
  struct arguments *args = pointer;
  REQUIRE(prctl(PR_SET_PDEATHSIG, SIGKILL));
  REQUIRE(close(args->writer));
  char ready;
  if (read(args->ready, &ready, 1) != 1) _exit(126);
  struct sigaction normal={.sa_handler=SIG_DFL};
  REQUIRE(sigaction(SIGTERM,&normal,NULL));
  REQUIRE(sigprocmask(SIG_SETMASK,&args->signal_mask,NULL));
  REQUIRE(setresgid(0,0,0)); REQUIRE(setresuid(0,0,0));
  REQUIRE(prctl(PR_SET_PDEATHSIG, SIGKILL));
  struct pollfd parent_gate={.fd=args->ready,.events=POLLHUP};
  if(poll(&parent_gate,1,0)<0 || (parent_gate.revents&POLLHUP))_exit(126);
  REQUIRE(close(args->ready));
  REQUIRE(mount(NULL, "/", NULL, MS_REC|MS_PRIVATE, NULL));
  REQUIRE(mount("proc", "/proc", "proc", MS_NOSUID|MS_NODEV|MS_NOEXEC, NULL));
  char options[128];
  snprintf(options,sizeof(options),"size=%s,mode=1777",args->tmpbytes);
  REQUIRE(mount("tmpfs", "/tmp", "tmpfs", MS_NOSUID|MS_NODEV|MS_NOEXEC, options));
  REQUIRE(mount("tmpfs", "/dev/shm", "tmpfs", MS_NOSUID|MS_NODEV|MS_NOEXEC, options));
  REQUIRE(mount("tmpfs", "/dev/mqueue", "tmpfs", MS_NOSUID|MS_NODEV|MS_NOEXEC, options));
  unsigned int runtime=(1U<<CAP_SETUID)|(1U<<CAP_SETGID)|(1U<<CAP_CHOWN)|(1U<<CAP_KILL);
  struct __user_cap_header_struct header={.version=_LINUX_CAPABILITY_VERSION_3};
  struct __user_cap_data_struct caps[2]={{.effective=runtime,.permitted=runtime},{0}};
  REQUIRE(syscall(SYS_capset,&header,caps));
  REQUIRE(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0));
  struct rlimit threads={32,32},core={0,0};
  REQUIRE(setrlimit(RLIMIT_NPROC,&threads)); REQUIRE(setrlimit(RLIMIT_CORE,&core));
  REQUIRE(constrain_namespaces());
  REQUIRE(syscall(SYS_close_range,3U,~0U,0));
  char *empty_env[]={NULL};
  execve(args->command[0],args->command,empty_env);
  fail("job_exec"); return 126;
}
static void mapping(pid_t pid,const char *name,unsigned long first) {
  char path[128],value[128];snprintf(path,sizeof(path),"/proc/%d/%s",pid,name);
  int file=open(path,O_WRONLY|O_CLOEXEC);REQUIRE(file);
  int length=snprintf(value,sizeof(value),"0 %lu 65536\n",first);
  if(write(file,value,length)!=length)fail("job_mapping");
  REQUIRE(close(file));
}
int main(int argc,char **argv) {
  if(argc==2&&!strcmp(argv[1],"--verify-role")) {
    extern char **environ;
    struct stat tmp;
    if(getpid()!=1 || getppid()!=0 || environ[0] || stat("/tmp",&tmp) || tmp.st_uid!=0)return 126;
    errno=0;if(syscall(SYS_unshare,CLONE_NEWUSER)!=-1 || errno!=EPERM)return 126;
    errno=0;if(mount(NULL,"/",NULL,MS_PRIVATE,NULL)!=-1 || errno!=EPERM)return 126;
    errno=0;
    long nested=syscall(SYS_clone,CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNET|CLONE_NEWNS|CLONE_NEWIPC|SIGCHLD,NULL,NULL,NULL,0);
    if(nested==0)_exit(126);
    if(nested>0){kill((pid_t)nested,SIGKILL);waitpid((pid_t)nested,NULL,0);return 126;}
    if(errno!=EPERM)return 126;
    struct clone_args clone_request={.flags=CLONE_NEWUSER,.exit_signal=SIGCHLD};
    errno=0;if(syscall(SYS_clone3,&clone_request,sizeof(clone_request))!=-1 || errno!=ENOSYS)return 126;
    return 0;
  }
  if(argc==2&&!strcmp(argv[1],"--help")){puts("Usage: job-isolate FIRST_UID TMP_BYTES EXECUTABLE [ARGS...] (supervisor only)");return 0;}
  if(argc<4||geteuid()!=0)return 126;
  char *end;unsigned long first=strtoul(argv[1],&end,10);if(*end||first<20000||first>0x7fffffffUL-65536)return 126;
  unsigned long bytes=strtoul(argv[2],&end,10);if(*end||!bytes)return 126;
  pid_t parent=getppid();REQUIRE(prctl(PR_SET_PDEATHSIG,SIGKILL));if(getppid()!=parent)return 126;
  REQUIRE(setgroups(0,NULL));REQUIRE(setsid());
  sigset_t blocked,original;sigemptyset(&blocked);sigaddset(&blocked,SIGTERM);
  REQUIRE(sigprocmask(SIG_BLOCK,&blocked,&original));
  struct sigaction termination={.sa_handler=cancel_job};
  REQUIRE(sigaction(SIGTERM,&termination,NULL));
  int gate[2];REQUIRE(pipe2(gate,O_CLOEXEC));
  void *stack=malloc(1024*1024);if(!stack)return 126;
  struct arguments args={.command=argv+3,.ready=gate[0],.writer=gate[1],.tmpbytes=argv[2],.signal_mask=original};
  pid_t pid=clone(child,(char*)stack+1024*1024,CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNS|CLONE_NEWNET|CLONE_NEWIPC|SIGCHLD,&args);
  REQUIRE(pid);REQUIRE(close(gate[0]));
  init_pid=pid;
  mapping(pid,"uid_map",first);mapping(pid,"gid_map",first);
  if(write(gate[1],"1",1)!=1)fail("job_start");
  REQUIRE(sigprocmask(SIG_SETMASK,&original,NULL));
  int status;while(waitpid(pid,&status,0)<0){if(errno!=EINTR)fail("job_wait");}
  REQUIRE(close(gate[1]));
  /* Only these exits prove waitpid reaped the namespace: success, cancellation, role failure. */
  free(stack);return cancelled?124:(WIFEXITED(status)&&WEXITSTATUS(status)==0?0:125);
}
