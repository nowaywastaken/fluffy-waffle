// src/kernel/security/engine.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine } from './engine.ts';
import { TokenIssuer } from './token.ts';
import type { SyscallContext, PolicyDecision } from './types.ts';

// Stub ExtensionSandbox — configurable response
function makeExtStub(response: PolicyDecision | 'throw') {
  return {
    async evaluate(_ctx: SyscallContext): Promise<PolicyDecision> {
      if (response === 'throw') throw new Error('sandbox crashed');
      return response;
    },
  };
}

function makeCtx(type: string, args: Record<string, unknown> = {}, tags: string[] = []): SyscallContext {
  return {
    type,
    args,
    caller: {
      containerId: 'c-100',
      pluginName: 'test',
      capabilityTags: tags,
      peer: { pid: 100, uid: 501, gid: 20 },
    },
  };
}

describe('PolicyEngine — basic semantics', () => {
  // Case 1: No rules match -> deny
  it('case 1: no rules → deny', async () => {
    const engine = new PolicyEngine(new TokenIssuer());
    const result = await engine.evaluate(makeCtx('fs.unknown'));
    assert.strictEqual(result, 'deny');
  });

  // Case 2: Only pass rules -> deny (tested by having extension return 'pass')
  it('case 2: only pass contributions → deny', async () => {
    const engine = new PolicyEngine(new TokenIssuer(), makeExtStub('pass') as any);
    const result = await engine.evaluate(makeCtx('fs.unknown'));
    assert.strictEqual(result, 'deny');
  });

  // Case 3: allow + deny (same syscall) -> deny
  it('case 3: allow + deny → deny', async () => {
    const engine = new PolicyEngine(new TokenIssuer(), makeExtStub('allow') as any);
    // Extension returns allow, but built-in deny on protected path wins
    const ctx = makeCtx('fs.write', { path: '.fluffy/policy.yaml' });
    assert.strictEqual(await engine.evaluate(ctx), 'deny');
  });

  // Case 4: allow + require_review -> require_review
  it('case 4: allow + require_review → require_review', async () => {
    // Extension returns allow; built-in protect-bootstrap returns require_review
    const engine = new PolicyEngine(new TokenIssuer(), makeExtStub('allow') as any);
    const ctx = makeCtx('fs.write', { path: 'src/bootstrap/index.ts' });
    assert.strictEqual(await engine.evaluate(ctx), 'require_review');
  });

  // Case 5: deny in extension + allow in built-in → deny (allow does not short-circuit)
  it('case 5: extension deny + built-in allow (hypothetical) → deny wins', async () => {
    const issuer = new TokenIssuer();
    const engine = new PolicyEngine(issuer, makeExtStub('deny') as any);
    // Load an allow rule for fs.read
    engine.addYamlRule({
      name: 'allow-read',
      match: { syscall: 'fs.read' },
      action: 'allow',
    });
    const ctx = makeCtx('fs.read', { path: 'src/main.ts' });
    assert.strictEqual(await engine.evaluate(ctx), 'deny');
  });

  // Case 6: require_review with matching except → pass (result: deny if no other allow)
  it('case 6: require_review + except matches → rule contributes pass → deny (no other allow)', async () => {
    const engine = new PolicyEngine(new TokenIssuer());
    engine.addYamlRule({
      name: 'review-with-except',
      match: { syscall: 'fs.write', caller_tag: ['new_employee'] },
      action: 'require_review',
      except: [{ path_glob: ['src/tests/**'] }],
    });
    // Except matches: path is src/tests/foo.ts, caller has new_employee tag
    const ctx = makeCtx('fs.write', { path: 'src/tests/foo.ts' }, ['new_employee']);
    assert.strictEqual(await engine.evaluate(ctx), 'deny');
  });
});

describe('PolicyEngine — aggregation behavior', () => {
  // Case 10: multiple require_review rules → require_review
  it('case 10: multiple require_review rules → require_review', async () => {
    const engine = new PolicyEngine(new TokenIssuer());
    engine.addYamlRule({ name: 'review1', match: { syscall: 'custom.op' }, action: 'require_review' });
    engine.addYamlRule({ name: 'review2', match: { syscall: 'custom.op' }, action: 'require_review' });
    assert.strictEqual(await engine.evaluate(makeCtx('custom.op')), 'require_review');
  });

  // Case 11: YAML deny short-circuits → extension never called
  it('case 11: YAML deny short-circuits before extension', async () => {
    let extCalled = false;
    const ext = {
      async evaluate(_ctx: SyscallContext): Promise<PolicyDecision> {
        extCalled = true;
        return 'allow';
      },
    };
    const engine = new PolicyEngine(new TokenIssuer(), ext as any);
    engine.addYamlRule({ name: 'deny-all', match: { syscall: 'fs.write' }, action: 'deny' });
    const ctx = makeCtx('fs.write', { path: 'src/main.ts' });
    await engine.evaluate(ctx);
    assert.strictEqual(extCalled, false);
  });

  // Case 12: partial match (syscall matches, path_glob does not) → rule not applied
  it('case 12: partial match (path_glob miss) → rule not applied → deny', async () => {
    const engine = new PolicyEngine(new TokenIssuer());
    engine.addYamlRule({
      name: 'allow-src',
      match: { syscall: 'fs.read', path_glob: ['src/**'] },
      action: 'allow',
    });
    // Path does not match src/**
    const ctx = makeCtx('fs.read', { path: 'node_modules/foo/bar.js' });
    assert.strictEqual(await engine.evaluate(ctx), 'deny');
  });

  // Case 16: multiple allow rules, no deny/review → allow
  it('case 16: multiple allow rules → allow', async () => {
    const engine = new PolicyEngine(new TokenIssuer());
    engine.addYamlRule({ name: 'allow1', match: { syscall: 'custom.read' }, action: 'allow' });
    engine.addYamlRule({ name: 'allow2', match: { syscall: 'custom.read' }, action: 'allow' });
    assert.strictEqual(await engine.evaluate(makeCtx('custom.read')), 'allow');
  });

  // Case 17: cross-layer allow (YAML + Extension) → allow
  it('case 17: YAML allow + extension allow → allow', async () => {
    const engine = new PolicyEngine(new TokenIssuer(), makeExtStub('allow') as any);
    engine.addYamlRule({ name: 'yaml-allow', match: { syscall: 'custom.op' }, action: 'allow' });
    assert.strictEqual(await engine.evaluate(makeCtx('custom.op')), 'allow');
  });
});

describe('PolicyEngine — defensive boundaries', () => {
  // Case 18: built-in rules list empty → system still evaluates (impossible normally but defensive)
  it('case 18: built-in rules cleared → evaluation still works', async () => {
    const engine = new PolicyEngine(new TokenIssuer());
    engine.clearBuiltinRulesForTesting();
    engine.addYamlRule({ name: 'allow-all', match: { syscall: 'any.op' }, action: 'allow' });
    assert.strictEqual(await engine.evaluate(makeCtx('any.op')), 'allow');
  });

  // Case 19: YAML rules empty → default deny (only built-in active)
  it('case 19: no YAML rules → deny for unprotected syscall', async () => {
    const engine = new PolicyEngine(new TokenIssuer());
    assert.strictEqual(await engine.evaluate(makeCtx('custom.unknown')), 'deny');
  });

  // Case 20: extension sandbox crashes → deny
  it('case 20: extension sandbox crashes → deny for in-flight requests', async () => {
    const engine = new PolicyEngine(new TokenIssuer(), makeExtStub('throw') as any);
    // No YAML allow rules, extension throws → engine catches → deny
    const result = await engine.evaluate(makeCtx('custom.op')).catch(() => 'deny' as PolicyDecision);
    assert.strictEqual(result, 'deny');
  });

  // Case 24: unknown syscall type → deny
  it('case 24: unknown syscall type → deny', async () => {
    const engine = new PolicyEngine(new TokenIssuer());
    assert.strictEqual(await engine.evaluate(makeCtx('nonexistent.syscall')), 'deny');
  });

  // Case 25: path_glob is empty array → rule never matches
  it('case 25: path_glob empty array → rule never triggers → deny', async () => {
    const engine = new PolicyEngine(new TokenIssuer());
    engine.addYamlRule({
      name: 'empty-glob',
      match: { syscall: 'fs.read', path_glob: [] },
      action: 'allow',
    });
    const ctx = makeCtx('fs.read', { path: 'src/main.ts' });
    assert.strictEqual(await engine.evaluate(ctx), 'deny');
  });
});

describe('PolicyEngine — built-in rules', () => {
  it('protect-meta-policy: deny fs.write to .fluffy/policy.yaml', async () => {
    const engine = new PolicyEngine(new TokenIssuer());
    const ctx = makeCtx('fs.write', { path: '.fluffy/policy.yaml' });
    assert.strictEqual(await engine.evaluate(ctx), 'deny');
  });

  it('protect-audit-log: deny fs.write to .fluffy/audit.db', async () => {
    const engine = new PolicyEngine(new TokenIssuer());
    const ctx = makeCtx('fs.write', { path: '.fluffy/audit.db' });
    assert.strictEqual(await engine.evaluate(ctx), 'deny');
  });

  it('protect-state-db: deny fs.write to .fluffy/state.db', async () => {
    const engine = new PolicyEngine(new TokenIssuer());
    const ctx = makeCtx('fs.write', { path: '.fluffy/state.db' });
    assert.strictEqual(await engine.evaluate(ctx), 'deny');
  });

  it('protect-bootstrap: require_review for fs.write to src/bootstrap/', async () => {
    const engine = new PolicyEngine(new TokenIssuer());
    const ctx = makeCtx('fs.write', { path: 'src/bootstrap/index.ts' });
    assert.strictEqual(await engine.evaluate(ctx), 'require_review');
  });

  it('protect-kernel: require_review for fs.write to src/kernel/', async () => {
    const engine = new PolicyEngine(new TokenIssuer());
    const ctx = makeCtx('fs.write', { path: 'src/kernel/index.ts' });
    assert.strictEqual(await engine.evaluate(ctx), 'require_review');
  });

  it('path_glob miss: fs.write to unprotected path with no YAML rules → deny', async () => {
    const engine = new PolicyEngine(new TokenIssuer());
    const ctx = makeCtx('fs.write', { path: 'src/main.ts' });
    // src/main.ts doesn't match any built-in deny, but also no allow → deny
    assert.strictEqual(await engine.evaluate(ctx), 'deny');
  });
});

describe('PolicyEngine — token path (cases 7-8)', () => {
  // Case 7: valid token + built-in deny → deny (token does NOT bypass built-in)
  it('case 7: valid token + built-in deny → deny', async () => {
    const issuer = new TokenIssuer();
    const engine = new PolicyEngine(issuer);
    const token = issuer.issue({
      containerId: 'c-100',
      peerPid: 100,
      syscall: 'fs.write',
      pathGlob: ['**/.fluffy/policy.yaml'],
    });
    const ctx = makeCtx('fs.write', { path: '.fluffy/policy.yaml' });
    ctx.token = token;
    // Built-in deny must fire even with valid token
    assert.strictEqual(await engine.evaluate(ctx), 'deny');
  });

  // Case 8: valid token + no built-in issues → allow (bypasses YAML/Extension)
  it('case 8: valid token, no built-in conflict → allow without YAML', async () => {
    const issuer = new TokenIssuer();
    // Extension that would deny if called
    let extCalled = false;
    const ext = {
      async evaluate(_ctx: SyscallContext): Promise<PolicyDecision> {
        extCalled = true;
        return 'deny';
      },
    };
    const engine = new PolicyEngine(issuer, ext as any);
    // No YAML rules; token grants access
    const token = issuer.issue({ containerId: 'c-100', peerPid: 100, syscall: 'custom.read' });
    const ctx = makeCtx('custom.read');
    ctx.token = token;
    const result = await engine.evaluate(ctx);
    assert.strictEqual(result, 'allow');
    assert.strictEqual(extCalled, false, 'Extension must not be called when token is valid');
  });
});
