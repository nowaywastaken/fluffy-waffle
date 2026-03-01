import { spawn } from 'child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  status: number;
}

export interface ExecOptions {
  stdin?: string;
  timeoutMs?: number;
  maxCaptureBytes?: number;
}

// Safe wrapper: uses spawn (not exec) — args array bypasses shell entirely
export function execFileNoThrow(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const maxCaptureBytes = options.maxCaptureBytes ?? 1024 * 1024;
  const truncationMarker = '...[truncated]';

  type CaptureState = {
    text: string;
    bytes: number;
    truncated: boolean;
  };

  const appendChunk = (state: CaptureState, chunk: string): void => {
    if (state.truncated || maxCaptureBytes <= 0) {
      state.truncated = true;
      return;
    }

    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    const remaining = maxCaptureBytes - state.bytes;
    if (remaining <= 0) {
      state.truncated = true;
      return;
    }

    if (chunkBytes <= remaining) {
      state.text += chunk;
      state.bytes += chunkBytes;
      return;
    }

    const buf = Buffer.from(chunk, 'utf8');
    state.text += buf.subarray(0, remaining).toString('utf8');
    state.bytes = maxCaptureBytes;
    state.truncated = true;
  };

  const finalizeCapturedText = (state: CaptureState): string => {
    if (!state.truncated) return state.text;
    return `${state.text}${truncationMarker}`;
  };

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutState: CaptureState = { text: '', bytes: 0, truncated: false };
    const stderrState: CaptureState = { text: '', bytes: 0, truncated: false };
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (status: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stdout = finalizeCapturedText(stdoutState);
      const stderr = finalizeCapturedText(stderrState);
      resolve({ stdout, stderr, status });
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeoutMs);
      timer.unref();
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      appendChunk(stdoutState, chunk);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      appendChunk(stderrState, chunk);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (!stderrState.text) {
        appendChunk(stderrState, error.message);
      }
      finish(error.code === 'ENOENT' ? 127 : 1);
    });

    child.on('close', (code) => {
      if (timedOut) {
        const prefix = stderrState.bytes > 0 ? '\n' : '';
        appendChunk(stderrState, `${prefix}Command timed out after ${options.timeoutMs}ms`);
        finish(124);
        return;
      }
      finish(typeof code === 'number' ? code : 1);
    });

    if (typeof options.stdin === 'string') {
      child.stdin.end(options.stdin);
      return;
    }
    child.stdin.end();
  });
}
