import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from './store.ts';
import type { SessionState } from './types.ts';

const SAMPLE_STATE: SessionState = {
  state: 'coding',
  mode: 'strict',
  previous_state: 'test_running',
  consecutive_failures: 2,
  test_files: ['tests/app.test.ts'],
  last_test_passed: false,
};

describe('state/store', () => {
  it('saves and loads state snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fluffy-state-store-'));
    const store = new StateStore(join(dir, 'state.db'));

    store.save(SAMPLE_STATE);
    const loaded = store.load();

    assert.deepEqual(loaded, SAMPLE_STATE);
    store.close();
  });

  it('returns null when no state is persisted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fluffy-state-store-'));
    const store = new StateStore(join(dir, 'state.db'));

    assert.equal(store.load(), null);
    store.close();
  });
});
