import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import {
  writeSeccompProfile,
  SECCOMP_STRICT,
  SECCOMP_STANDARD,
  SECCOMP_STANDARD_NET,
} from './seccomp.ts';

describe('Seccomp profiles', () => {
  it('SECCOMP_STRICT has defaultAction SCMP_ACT_ERRNO', () => {
    assert.equal(SECCOMP_STRICT.defaultAction, 'SCMP_ACT_ERRNO');
  });

  it('SECCOMP_STRICT does not allow fork', () => {
    const allNames = SECCOMP_STRICT.syscalls.flatMap(s => s.names);
    assert.ok(!allNames.includes('fork'));
  });

  it('SECCOMP_STANDARD allows fork', () => {
    const allNames = SECCOMP_STANDARD.syscalls.flatMap(s => s.names);
    assert.ok(allNames.includes('fork'));
  });

  it('SECCOMP_STANDARD socket rule has AF_UNIX restriction', () => {
    const socketRules = SECCOMP_STANDARD.syscalls.filter(s => s.names.includes('socket'));
    const allHaveArgs = socketRules.every(r => r.args && r.args.length > 0);
    assert.ok(allHaveArgs, 'STANDARD socket must be restricted to AF_UNIX');
  });

  it('SECCOMP_STANDARD_NET has unrestricted socket rule', () => {
    const socketRules = SECCOMP_STANDARD_NET.syscalls.filter(s => s.names.includes('socket'));
    const hasUnrestricted = socketRules.some(r => !r.args || r.args.length === 0);
    assert.ok(hasUnrestricted);
  });

  it('writeSeccompProfile writes valid JSON and returns path', async () => {
    const filePath = await writeSeccompProfile('strict');
    assert.ok(filePath.endsWith('seccomp-strict.json'));
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);
    assert.equal(parsed.defaultAction, 'SCMP_ACT_ERRNO');
    await fs.unlink(filePath).catch(() => {});
  });
});
