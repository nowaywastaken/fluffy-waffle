import { execFile } from 'child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  status: number;
}

// Safe wrapper: uses execFile (not exec) — args array bypasses shell entirely
export function execFileNoThrow(
  command: string,
  args: string[],
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(command, args, (error, stdout, stderr) => {
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        status: error?.code === 'ENOENT' ? 127 : (error ? 1 : 0),
      });
    });
  });
}
