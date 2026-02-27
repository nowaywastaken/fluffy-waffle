// src/kernel/security/engine.ts
import type {
  SyscallContext, PolicyDecision, PolicyRule, CompiledRule, MatchCondition,
} from './types.ts';
import { compileRule, loadYamlRules } from './yaml-loader.ts';
import type { TokenIssuer } from './token.ts';

export interface ExtensionSandboxLike {
  evaluate(ctx: SyscallContext): Promise<PolicyDecision>;
}

const BUILTIN_RULES: CompiledRule[] = ([
  {
    name: 'protect-meta-policy',
    match: { syscall: 'fs.write', path_glob: ['**/.fluffy/policy.yaml', '.fluffy/policy.yaml'] },
    action: 'deny',
    reason: 'Policy files cannot be modified via fs.write',
  },
  {
    name: 'protect-bootstrap',
    match: { syscall: 'fs.write', path_glob: ['src/bootstrap/**'] },
    action: 'require_review',
    reason: 'Bootstrap code modification requires review',
  },
  {
    name: 'protect-kernel',
    match: { syscall: 'fs.write', path_glob: ['src/kernel/**'] },
    action: 'require_review',
    reason: 'Kernel code modification requires review',
  },
  {
    name: 'protect-audit-log',
    match: { syscall: 'fs.write', path_glob: ['**/.fluffy/audit.db', '.fluffy/audit.db'] },
    action: 'deny',
    reason: 'Audit log cannot be modified via fs.write',
  },
  {
    name: 'protect-state-db',
    match: { syscall: 'fs.write', path_glob: ['**/.fluffy/state.db', '.fluffy/state.db'] },
    action: 'deny',
    reason: 'State machine DB cannot be modified via fs.write',
  },
] as PolicyRule[]).map(compileRule);

export class PolicyEngine {
  private builtinRules: CompiledRule[] = [...BUILTIN_RULES];
  private yamlRules = new Map<string, CompiledRule[]>();
  private readonly tokenIssuer: TokenIssuer;
  private readonly extension?: ExtensionSandboxLike;

  constructor(tokenIssuer: TokenIssuer, extension?: ExtensionSandboxLike) {
    this.tokenIssuer = tokenIssuer;
    this.extension = extension;
  }

  loadYamlRules(filePath: string): void {
    this.yamlRules = loadYamlRules(filePath);
  }

  // For testing only: allows case 18 (empty built-in rules)
  clearBuiltinRulesForTesting(): void {
    this.builtinRules = [];
  }

  // For testing: add a single YAML rule programmatically
  addYamlRule(rule: PolicyRule): void {
    const compiled = compileRule(rule);
    const syscalls = rule.match.syscall
      ? (Array.isArray(rule.match.syscall) ? rule.match.syscall : [rule.match.syscall])
      : ['*'];
    for (const syscall of syscalls) {
      if (!this.yamlRules.has(syscall)) this.yamlRules.set(syscall, []);
      this.yamlRules.get(syscall)!.push(compiled);
    }
  }

  async evaluate(ctx: SyscallContext): Promise<PolicyDecision> {
    const now = Date.now();
    let hasAllow = false;
    let hasReview = false;

    // Phase 0: Built-in rules (always execute; only deny is terminal)
    for (const rule of this.builtinRules) {
      if (this.matchesRule(rule, ctx)) {
        if (rule.action === 'deny') return 'deny';
        if (rule.action === 'require_review') hasReview = true;
        if (rule.action === 'allow') hasAllow = true;
      }
    }

    // Phase 1: Token fast path
    if (ctx.token && this.tokenIssuer.validate(ctx.token, ctx, now)) {
      if (hasReview) return 'require_review';
      return 'allow';
    }

    // Phase 2: YAML rules
    const yamlMatches = [
      ...(this.yamlRules.get(ctx.type) ?? []),
      ...(this.yamlRules.get('*') ?? []),
    ];
    for (const rule of yamlMatches) {
      if (this.matchesRule(rule, ctx)) {
        if (rule.action === 'deny') return 'deny';
        if (rule.action === 'require_review') hasReview = true;
        if (rule.action === 'allow') hasAllow = true;
      }
    }

    // Phase 3: Extension rules
    if (this.extension) {
      let extDecision: PolicyDecision = 'deny';
      try {
        extDecision = await this.extension.evaluate(ctx);
      } catch {
        return 'deny'; // crash → fail-closed
      }
      if (extDecision === 'deny') return 'deny';
      if (extDecision === 'require_review') hasReview = true;
      if (extDecision === 'allow') hasAllow = true;
    }

    if (hasReview) return 'require_review';
    if (hasAllow) return 'allow';
    return 'deny';
  }

  private matchesRule(rule: CompiledRule, ctx: SyscallContext): boolean {
    const cond = rule.match;

    if (cond.syscall) {
      const types = Array.isArray(cond.syscall) ? cond.syscall : [cond.syscall];
      if (!types.includes(ctx.type) && !types.includes('*')) return false;
    }

    if (cond.caller_tag) {
      const tags = Array.isArray(cond.caller_tag) ? cond.caller_tag : [cond.caller_tag];
      if (!tags.some(t => ctx.caller.capabilityTags.includes(t))) return false;
    }

    if (cond.path_glob) {
      if (typeof ctx.args['path'] !== 'string') return false;
      if (rule._pathMatcher && !rule._pathMatcher(ctx.args['path'])) return false;
    }

    if (rule.except && this.isExcluded(rule, ctx)) return false;

    return true;
  }

  private isExcluded(rule: CompiledRule, ctx: SyscallContext): boolean {
    if (!rule.except) return false;
    for (let i = 0; i < rule.except.length; i++) {
      const cond = rule.except[i];
      const pathMatcher = rule._exceptMatchers?.[i];
      if (this.matchesCondition(cond, ctx, pathMatcher)) return true;
    }
    return false;
  }

  private matchesCondition(
    cond: MatchCondition,
    ctx: SyscallContext,
    pathMatcher?: (path: string) => boolean,
  ): boolean {
    if (cond.syscall) {
      const types = Array.isArray(cond.syscall) ? cond.syscall : [cond.syscall];
      if (!types.includes(ctx.type)) return false;
    }
    if (cond.caller_tag) {
      const tags = Array.isArray(cond.caller_tag) ? cond.caller_tag : [cond.caller_tag];
      if (!tags.some(t => ctx.caller.capabilityTags.includes(t))) return false;
    }
    if (cond.path_glob) {
      if (typeof ctx.args['path'] !== 'string') return false;
      if (pathMatcher && !pathMatcher(ctx.args['path'])) return false;
    }
    return true;
  }
}
