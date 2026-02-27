// src/kernel/security/schema-warnings.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as url from 'node:url';
import { loadYamlRules } from './yaml-loader.ts';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURES = path.join(DIR, 'fixtures');

describe('Schema warnings and errors', () => {
  // Case 26: match and except conditions identical → schema warning logged
  it('case 26: identical match and except → warns to console', () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      loadYamlRules(path.join(FIXTURES, 'rules-identical-except.yaml'));
    } finally {
      console.warn = origWarn;
    }
    assert.ok(warnings.some(w => w.includes('identical')), `Expected identical warning, got: ${warnings}`);
  });

  // YAML schema: missing name throws
  it('YAML schema error (missing name) throws at load time', () => {
    assert.throws(
      () => loadYamlRules(path.join(FIXTURES, 'rules-bad-name.yaml')),
      /missing required field "name"/,
    );
  });

  // YAML schema: invalid action throws
  it('YAML schema error (invalid action) throws at load time', () => {
    assert.throws(
      () => loadYamlRules(path.join(FIXTURES, 'rules-bad-action.yaml')),
      /invalid action/,
    );
  });
});
