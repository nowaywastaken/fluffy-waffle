// src/kernel/security/yaml-loader.ts
import * as fs from 'node:fs';
import { parse } from 'yaml';
import picomatch from 'picomatch';
import type { PolicyRule, CompiledRule, MatchCondition } from './types.ts';

function compileConditionMatcher(cond: MatchCondition): ((path: string) => boolean) | undefined {
  if (!cond.path_glob) return undefined;
  const globs = Array.isArray(cond.path_glob) ? cond.path_glob : [cond.path_glob];
  if (globs.length === 0) return () => false;
  return picomatch(globs);
}

export function compileRule(rule: PolicyRule): CompiledRule {
  const compiled: CompiledRule = { ...rule };

  const pathMatcher = compileConditionMatcher(rule.match);
  if (pathMatcher) {
    compiled._pathMatcher = pathMatcher;
  }

  if (rule.except) {
    compiled._exceptMatchers = rule.except.map(compileConditionMatcher).map(fn => fn ?? (() => false));
    // Warn if match and except are identical (case 26)
    const matchStr = JSON.stringify(rule.match);
    for (const exc of rule.except) {
      if (JSON.stringify(exc) === matchStr) {
        console.warn(`[policy] Rule "${rule.name}": match and except conditions are identical — rule will never trigger`);
      }
    }
  }

  // Warn if path_glob is empty array (case 25)
  if (Array.isArray(rule.match.path_glob) && rule.match.path_glob.length === 0) {
    console.warn(`[policy] Rule "${rule.name}": path_glob is empty array — rule will never match any path`);
  }

  return compiled;
}

function validateRule(raw: unknown, index: number): PolicyRule {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Rule at index ${index}: must be an object`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r['name'] !== 'string') {
    throw new Error(`Rule at index ${index}: missing required field "name"`);
  }
  if (typeof r['match'] !== 'object' || r['match'] === null) {
    throw new Error(`Rule "${r['name']}": missing required field "match"`);
  }
  const validActions = ['allow', 'deny', 'require_review'];
  if (!validActions.includes(r['action'] as string)) {
    throw new Error(`Rule "${r['name']}": invalid action "${r['action']}". Must be: ${validActions.join('|')}`);
  }
  return raw as PolicyRule;
}

export function loadYamlRules(filePath: string): Map<string, CompiledRule[]> {
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = parse(content) as { capabilities?: unknown[] } | null;

  const index = new Map<string, CompiledRule[]>();
  if (!parsed?.capabilities) return index;

  for (let i = 0; i < parsed.capabilities.length; i++) {
    const rule = validateRule(parsed.capabilities[i], i);
    const compiled = compileRule(rule);

    const syscalls = rule.match.syscall
      ? (Array.isArray(rule.match.syscall) ? rule.match.syscall : [rule.match.syscall])
      : ['*'];

    for (const syscall of syscalls) {
      if (!index.has(syscall)) index.set(syscall, []);
      index.get(syscall)!.push(compiled);
    }
  }

  return index;
}
