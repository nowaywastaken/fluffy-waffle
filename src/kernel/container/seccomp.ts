import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

interface SyscallRule {
  names: string[];
  action: string;
  args?: { index: number; value: number; op: string }[];
}

interface SeccompProfile {
  defaultAction: string;
  architectures: string[];
  syscalls: SyscallRule[];
}

const BASE_SYSCALLS: SyscallRule[] = [
  {
    names: [
      'read', 'write', 'close', 'fstat', 'lseek', 'mmap',
      'mprotect', 'munmap', 'brk', 'futex', 'nanosleep',
      'exit', 'exit_group', 'rt_sigaction', 'rt_sigprocmask', 'sigreturn',
      'gettimeofday', 'clock_gettime', 'clock_nanosleep',
    ],
    action: 'SCMP_ACT_ALLOW',
  },
  {
    names: ['socket'],
    action: 'SCMP_ACT_ALLOW',
    args: [{ index: 0, value: 1, op: 'SCMP_CMP_EQ' }], // AF_UNIX=1 only
  },
  {
    names: [
      'connect', 'send', 'recv', 'sendto', 'recvfrom',
      'getsockopt', 'setsockopt', 'bind', 'listen', 'accept',
    ],
    action: 'SCMP_ACT_ALLOW',
  },
];

export const SECCOMP_STRICT: SeccompProfile = {
  defaultAction: 'SCMP_ACT_ERRNO',
  architectures: ['SCMP_ARCH_X86_64', 'SCMP_ARCH_AARCH64'],
  syscalls: BASE_SYSCALLS,
};

const STANDARD_EXTRA: SyscallRule[] = [
  {
    names: [
      'fork', 'execve', 'wait4', 'waitpid', 'getpid', 'getppid',
      'getuid', 'getgid', 'open', 'openat', 'unlink', 'unlinkat',
      'mkdir', 'mkdirat', 'rmdir', 'rename', 'renameat',
      'stat', 'lstat', 'access', 'chmod', 'chown',
      'pipe', 'pipe2', 'dup', 'dup2', 'dup3', 'fcntl', 'ioctl',
      'getcwd', 'chdir', 'getdents', 'getdents64',
    ],
    action: 'SCMP_ACT_ALLOW',
  },
  {
    names: ['clone'],
    action: 'SCMP_ACT_ALLOW',
    // no CLONE_NEWUSER or CLONE_NEWNS
    args: [{ index: 0, value: 0x10000000, op: 'SCMP_CMP_MASKED_EQ' }],
  },
];

export const SECCOMP_STANDARD: SeccompProfile = {
  defaultAction: 'SCMP_ACT_ERRNO',
  architectures: ['SCMP_ARCH_X86_64', 'SCMP_ARCH_AARCH64'],
  syscalls: [...BASE_SYSCALLS, ...STANDARD_EXTRA],
};

export const SECCOMP_STANDARD_NET: SeccompProfile = {
  defaultAction: 'SCMP_ACT_ERRNO',
  architectures: ['SCMP_ARCH_X86_64', 'SCMP_ARCH_AARCH64'],
  syscalls: [
    ...SECCOMP_STANDARD.syscalls,
    { names: ['socket'], action: 'SCMP_ACT_ALLOW' }, // unrestricted for network
  ],
};

const PROFILES: Record<string, SeccompProfile> = {
  strict: SECCOMP_STRICT,
  standard: SECCOMP_STANDARD,
  'standard-net': SECCOMP_STANDARD_NET,
};

export async function writeSeccompProfile(
  profile: 'strict' | 'standard' | 'standard-net',
): Promise<string> {
  const tmpPath = path.join(os.tmpdir(), `seccomp-${profile}.json`);
  await fs.writeFile(tmpPath, JSON.stringify(PROFILES[profile]));
  return tmpPath;
}
