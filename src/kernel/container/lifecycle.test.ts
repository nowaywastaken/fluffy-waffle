import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SandboxLifecycle } from './lifecycle.ts';

describe('SandboxLifecycle', () => {
  let lc: SandboxLifecycle;

  beforeEach(() => { lc = new SandboxLifecycle(); });

  it('valid transition: creating -> running', () => {
    lc.transition('box1', 'running');
    assert.equal(lc.get('box1'), 'running');
  });

  it('valid path: running -> stopping -> cleanup -> destroyed', () => {
    lc.transition('box1', 'running');
    lc.transition('box1', 'stopping');
    lc.transition('box1', 'cleanup');
    lc.transition('box1', 'destroyed');
    assert.equal(lc.get('box1'), 'destroyed');
  });

  it('valid path: creating -> failed -> cleanup -> destroyed', () => {
    lc.transition('box1', 'failed');
    lc.transition('box1', 'cleanup');
    lc.transition('box1', 'destroyed');
    assert.equal(lc.get('box1'), 'destroyed');
  });

  it('invalid transition throws', () => {
    lc.transition('box1', 'running');
    assert.throws(
      () => lc.transition('box1', 'creating'),
      /Invalid transition: running -> creating/,
    );
  });

  it('cannot transition from destroyed', () => {
    lc.transition('box1', 'running');
    lc.transition('box1', 'stopping');
    lc.transition('box1', 'cleanup');
    lc.transition('box1', 'destroyed');
    assert.throws(
      () => lc.transition('box1', 'running'),
      /Invalid transition/,
    );
  });

  it('active() returns only non-destroyed sandboxes', () => {
    lc.transition('box1', 'running');
    lc.transition('box2', 'running');
    lc.transition('box2', 'stopping');
    lc.transition('box2', 'cleanup');
    lc.transition('box2', 'destroyed');
    assert.deepEqual(lc.active(), ['box1']);
  });

  it('unknown sandbox returns destroyed', () => {
    assert.equal(lc.get('nonexistent'), 'destroyed');
  });
});
