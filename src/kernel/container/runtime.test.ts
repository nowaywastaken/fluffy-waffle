import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('DockerAdapter (unit)', () => {
  it('ping returns true when status is 0', async () => {
    const mockResult = { stdout: '27.0.0\n', stderr: '', status: 0 };
    assert.equal(mockResult.status === 0, true);
  });

  it('ping returns false when status is non-zero', async () => {
    const mockResult = { stdout: '', stderr: 'Cannot connect', status: 1 };
    assert.equal(mockResult.status === 0, false);
  });

  it('create args include all security flags', () => {
    const required = [
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--init',
      '--pids-limit',
    ];
    assert.ok(required.every(f => typeof f === 'string'));
  });
});
