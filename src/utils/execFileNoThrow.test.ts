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
});
