import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TddStateMachine } from './machine.ts';

function makeMachine(): TddStateMachine {
  return new TddStateMachine({ log: () => {} });
}

describe('state/machine', () => {
  it('supports strict-mode happy path', () => {
    const machine = makeMachine();

    machine.submitTask();
    machine.completePlanning();
    machine.registerTestFile('src/foo.test.ts');
    machine.completeTestWriting();
    machine.reportTestResult(false);
    machine.completeCoding();
    machine.reportTestResult(true);

    const state = machine.getState();
    assert.equal(state.state, 'done');
    assert.equal(state.mode, 'strict');
  });

  it('blocks code write before test phase', () => {
    const machine = makeMachine();
    machine.submitTask();
    machine.completePlanning();

    const allowed = machine.isToolAllowed({ tool: 'fs.write', target_path: 'src/app.ts' });
    assert.equal(allowed.allowed, false);
    assert.match(allowed.reason ?? '', /TEST_WRITING/i);

    const allowedTest = machine.isToolAllowed({ tool: 'fs.write', target_path: 'src/app.test.ts' });
    assert.equal(allowedTest.allowed, true);
  });

  it('requires at least one test file before entering test_running', () => {
    const machine = makeMachine();
    machine.submitTask();
    machine.completePlanning();

    assert.throws(() => machine.completeTestWriting(), /at least one test file/i);
    assert.equal(machine.getState().state, 'failed');
  });

  it('returns to test_writing when tests pass before coding', () => {
    const machine = makeMachine();
    machine.submitTask();
    machine.completePlanning();
    machine.registerTestFile('tests/hello.spec.ts');
    machine.completeTestWriting();

    machine.reportTestResult(true);

    assert.equal(machine.getState().state, 'test_writing');
  });

  it('keeps strict mode after three consecutive failures and continues enforcing gates', () => {
    const machine = makeMachine();
    machine.submitTask();
    machine.completePlanning();
    machine.registerTestFile('tests/flow.test.ts');

    machine.completeTestWriting();
    machine.reportTestResult(false);
    machine.completeCoding();
    machine.reportTestResult(false);
    machine.completeCoding();
    machine.reportTestResult(false);

    const state = machine.getState();
    assert.equal(state.mode, 'strict');
    assert.equal(state.consecutive_failures, 3);

    const shellAllowed = machine.isToolAllowed({ tool: 'shell.exec' });
    assert.equal(shellAllowed.allowed, false);
    assert.match(shellAllowed.reason ?? '', /coding state/i);

    const writeAllowed = machine.isToolAllowed({ tool: 'fs.write', target_path: 'src/main.ts' });
    assert.equal(writeAllowed.allowed, true);
  });

  it('allows exempt file writes in coding state', () => {
    const machine = makeMachine();
    machine.submitTask();
    machine.completePlanning();
    machine.registerTestFile('tests/setup.test.ts');
    machine.completeTestWriting();
    machine.reportTestResult(false);

    const configWrite = machine.isToolAllowed({ tool: 'fs.write', target_path: 'package.json' });
    assert.equal(configWrite.allowed, true);

    const testWrite = machine.isToolAllowed({ tool: 'fs.write', target_path: 'tests/setup.test.ts' });
    assert.equal(testWrite.allowed, false);
  });

  it('explore mode is read-only', () => {
    const machine = makeMachine();
    machine.setMode('explore');

    assert.equal(machine.isToolAllowed({ tool: 'fs.read' }).allowed, true);
    assert.equal(machine.isToolAllowed({ tool: 'test.run' }).allowed, false);
    assert.equal(machine.isToolAllowed({ tool: 'fs.write', target_path: 'src/a.ts' }).allowed, false);
  });

  it('hydrates persisted state snapshots', () => {
    const machine = makeMachine();
    machine.hydrate({
      state: 'coding',
      mode: 'strict',
      previous_state: 'test_running',
      consecutive_failures: 2,
      test_files: ['tests/foo.test.ts'],
      last_test_passed: false,
    });
    const state = machine.getState();
    assert.equal(state.state, 'coding');
    assert.equal(state.test_files[0], 'tests/foo.test.ts');
  });
});
