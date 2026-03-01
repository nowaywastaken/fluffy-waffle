import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileNoThrow } from './execFileNoThrow.ts';

describe('execFileNoThrow', () => {
  it('returns stdout and status 0 on success', async () => {
    const result = await execFileNoThrow('node', ['--version']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^v\d+/);
    assert.equal(result.stderr, '');
  });

  it('returns non-zero status on failure without throwing', async () => {
    const result = await execFileNoThrow('node', ['--invalid-flag-xyz']);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.length > 0);
  });

  it('never throws even on missing binary', async () => {
    const result = await execFileNoThrow('__nonexistent_binary__', []);
    assert.notEqual(result.status, 0);
  });

  it('supports sending stdin to child process', async () => {
    const result = await execFileNoThrow(
      'node',
      ['-e', 'process.stdin.setEncoding("utf8");let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>process.stdout.write(data));'],
      { stdin: 'hello-stdin' },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'hello-stdin');
  });

  it('returns timeout status 124 when command exceeds timeout', async () => {
    const result = await execFileNoThrow(
      'node',
      ['-e', 'setTimeout(() => {}, 5000)'],
      { timeoutMs: 10 },
    );
    assert.equal(result.status, 124);
    assert.match(result.stderr, /timed out/i);
  });

  it('truncates large stdout when maxCaptureBytes is reached', async () => {
    const result = await execFileNoThrow(
      'node',
      ['-e', 'process.stdout.write("x".repeat(20000));'],
      { maxCaptureBytes: 256 },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout.endsWith('...[truncated]'), true);
    assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 256 + '...[truncated]'.length);
  });
});
