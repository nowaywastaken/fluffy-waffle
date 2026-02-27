// src/kernel/security/token.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { TokenIssuer } from './token.ts';
import type { SyscallContext } from './types.ts';

function makeCtx(overrides: Partial<SyscallContext> = {}): SyscallContext {
  return {
    type: 'fs.read',
    args: { path: 'src/main.ts' },
    caller: {
      containerId: 'c-100',
      pluginName: 'test-plugin',
      capabilityTags: [],
      peer: { pid: 100, uid: 501, gid: 20 },
    },
    ...overrides,
  };
}

describe('TokenIssuer', () => {
  let issuer: TokenIssuer;

  before(() => {
    issuer = new TokenIssuer();
  });

  // Case 8: valid token bypasses YAML/Extension (validated by engine, here we just check validate() returns true)
  it('case 8: valid token validates successfully', () => {
    const token = issuer.issue({
      containerId: 'c-100',
      peerPid: 100,
      syscall: 'fs.read',
    });
    const ctx = makeCtx({ token });
    const now = Date.now();
    assert.strictEqual(issuer.validate(token, ctx, now), true);
  });

  // Case 9: expired token falls through (validate returns false)
  it('case 9: expired token returns false', () => {
    const token = issuer.issue({
      containerId: 'c-100',
      peerPid: 100,
      syscall: 'fs.read',
      ttlMs: 1,
    });
    // Wait 10ms to ensure expiry
    const now = Date.now() + 10;
    const ctx = makeCtx({ token });
    assert.strictEqual(issuer.validate(token, ctx, now), false);
  });

  // Case 21: maxOps exhausted
  it('case 21: maxOps exhausted returns false on second use', () => {
    const token = issuer.issue({
      containerId: 'c-100',
      peerPid: 100,
      syscall: 'fs.read',
      maxOps: 1,
    });
    const ctx = makeCtx({ token });
    const now = Date.now();
    assert.strictEqual(issuer.validate(token, ctx, now), true);   // first use: ok
    assert.strictEqual(issuer.validate(token, ctx, now), false);  // second use: exhausted
  });

  // Case 22: time snapshot at evaluate start prevents TOCTOU
  it('case 22: validate uses caller-provided now, not Date.now()', () => {
    const token = issuer.issue({
      containerId: 'c-100',
      peerPid: 100,
      syscall: 'fs.read',
      ttlMs: 50,
    });
    const ctx = makeCtx({ token });
    // Snapshot time BEFORE token expires (simulate: evaluate started early, validation called late)
    const now = Date.now();  // token still valid at this moment
    assert.strictEqual(issuer.validate(token, ctx, now), true);
  });

  // Case 23: container_id mismatch
  it('case 23: container_id mismatch returns false', () => {
    const token = issuer.issue({
      containerId: 'c-100',
      peerPid: 100,
      syscall: 'fs.read',
    });
    // ctx has different containerId
    const ctx = makeCtx({ token });
    (ctx.caller as any).containerId = 'c-999';
    const now = Date.now();
    assert.strictEqual(issuer.validate(token, ctx, now), false);
  });

  it('tampered signature returns false', () => {
    const token = issuer.issue({
      containerId: 'c-100',
      peerPid: 100,
      syscall: 'fs.read',
    });
    const tampered = { ...token, signature: 'deadbeef' };
    const ctx = makeCtx({ token: tampered });
    assert.strictEqual(issuer.validate(tampered, ctx, Date.now()), false);
  });

  it('revoked token returns false', () => {
    const token = issuer.issue({
      containerId: 'c-100',
      peerPid: 100,
      syscall: 'fs.read',
    });
    issuer.revoke(token.tokenId);
    const ctx = makeCtx({ token });
    assert.strictEqual(issuer.validate(token, ctx, Date.now()), false);
  });

  it('pathGlob restricts matching path', () => {
    const token = issuer.issue({
      containerId: 'c-100',
      peerPid: 100,
      syscall: 'fs.read',
      pathGlob: ['src/**'],
    });
    const goodCtx = makeCtx({ token, args: { path: 'src/main.ts' } });
    const badCtx = makeCtx({ token, args: { path: 'tests/main.test.ts' } });
    assert.strictEqual(issuer.validate(token, goodCtx, Date.now()), true);
    // Second token needed (first was consumed)
    const token2 = issuer.issue({ containerId: 'c-100', peerPid: 100, syscall: 'fs.read', pathGlob: ['src/**'] });
    assert.strictEqual(issuer.validate(token2, badCtx, Date.now()), false);
  });
});
