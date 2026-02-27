// src/kernel/security/yaml-loader.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as url from 'node:url';
import { loadYamlRules } from './yaml-loader.ts';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURES = path.join(DIR, 'fixtures');

describe('loadYamlRules', () => {
  it('loads and indexes rules by syscall type', () => {
    const index = loadYamlRules(path.join(FIXTURES, 'rules-valid.yaml'));
    assert.ok(index.has('fs.read'), 'should have fs.read rules');
    const readRules = index.get('fs.read')!;
    assert.strictEqual(readRules.length, 2);
    assert.strictEqual(readRules[0].name, 'allow-src-read');
  });

  it('pre-compiles path_glob into _pathMatcher', () => {
    const index = loadYamlRules(path.join(FIXTURES, 'rules-valid.yaml'));
    const rule = index.get('fs.read')![0];
    assert.ok(typeof rule._pathMatcher === 'function');
    assert.strictEqual(rule._pathMatcher('src/main.ts'), true);
    assert.strictEqual(rule._pathMatcher('tests/main.test.ts'), false);
  });

  it('returns empty map for empty rules file', () => {
    const index = loadYamlRules(path.join(FIXTURES, 'rules-empty.yaml'));
    assert.strictEqual(index.size, 0);
  });

  it('throws on missing required field "name"', () => {
    assert.throws(
      () => loadYamlRules(path.join(FIXTURES, 'rules-bad-name.yaml')),
      /missing required field "name"/,
    );
  });

  it('throws on invalid action value', () => {
    assert.throws(
      () => loadYamlRules(path.join(FIXTURES, 'rules-bad-action.yaml')),
      /invalid action/,
    );
  });

  it('indexes rules without explicit syscall under "*"', () => {
    const index = loadYamlRules(path.join(FIXTURES, 'rules-wildcard.yaml'));
    assert.ok(index.has('*'));
    assert.strictEqual(index.get('*')![0].name, 'global-deny-test');
  });
});
