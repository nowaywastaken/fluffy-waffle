import picomatch from 'picomatch';

/**
 * Security Policy Engine
 * Implements the "Default Deny" and "Multi-layer Evaluation" logic.
 */

export type PolicyDecision = 'allow' | 'deny' | 'require_review' | 'pass';

export interface SyscallContext {
  type: string;
  args: Record<string, unknown>;
  caller: {
    containerId: string;
    pluginName: string;
    capabilityTags: string[];
  };
  token?: string; // Capability Token
}

export interface PolicyRule {
  name: string;
  match: MatchCondition;
  action: 'allow' | 'deny' | 'require_review';
  except?: MatchCondition[];
  reason?: string;
  constraints?: Record<string, unknown>;
}

export interface MatchCondition {
  syscall?: string | string[];
  caller_tag?: string | string[];
  path_glob?: string | string[];
  [key: string]: unknown;
}

export class PolicyEngine {
  private builtinRules: PolicyRule[] = [];
  private yamlRules: Map<string, PolicyRule[]> = new Map(); // Indexed by syscall type
  
  constructor() {
    this.loadBuiltinRules();
  }

  private loadBuiltinRules() {
    // Hardcoded Built-in Rules (Max 10)
    this.builtinRules = [
      {
        name: 'protect-meta-policy',
        match: { syscall: 'fs.write', path_glob: ['**/.fluffy/policy.yaml'] },
        action: 'deny',
        reason: 'Policy files cannot be modified via fs.write'
      },
      {
        name: 'protect-bootstrap',
        match: { syscall: 'fs.write', path_glob: ['src/bootstrap/**'] },
        action: 'require_review',
        reason: 'Bootstrap code modification requires review'
      }
    ];
  }

  public addYamlRule(rule: PolicyRule) {
    const syscalls: string[] = [];
    if (typeof rule.match.syscall === 'string') {
      syscalls.push(rule.match.syscall);
    } else if (Array.isArray(rule.match.syscall)) {
      syscalls.push(...rule.match.syscall);
    } else {
      syscalls.push('*'); // Default to all if not specified? Or should match logic handle it?
    }

    for (const syscall of syscalls) {
      if (!this.yamlRules.has(syscall)) {
        this.yamlRules.set(syscall, []);
      }
      this.yamlRules.get(syscall)!.push(rule);
    }
  }

  public evaluate(ctx: SyscallContext): PolicyDecision {
    // 1. Built-in Rules (Always First)
    for (const rule of this.builtinRules) {
      // Evaluate built-in rules
      if (this.isMatch(rule.match, ctx)) {
         if (rule.action === 'deny') return 'deny';
         if (rule.action === 'require_review') return 'require_review';
         // 'allow' in built-in doesn't short-circuit, just continues
      }
    }

    // 2. Fast Path: Capability Token
    // Placeholder: if token valid -> return 'allow'

    // 3. YAML Rules (Slow Path)
    let hasAllow = false;
    let hasReview = false;

    // Get relevant rules for this syscall type AND global rules
    const relevantRules: PolicyRule[] = [];
    if (this.yamlRules.has(ctx.type)) {
      relevantRules.push(...this.yamlRules.get(ctx.type)!);
    }
    if (this.yamlRules.has('*')) {
      relevantRules.push(...this.yamlRules.get('*')!);
    }

    for (const rule of relevantRules) {
      if (this.isMatch(rule.match, ctx) && !this.isExcluded(rule, ctx)) {
        if (rule.action === 'deny') return 'deny';
        if (rule.action === 'require_review') hasReview = true;
        if (rule.action === 'allow') hasAllow = true;
      }
    }

    // 4. Final Decision
    if (hasReview) return 'require_review';
    if (hasAllow) return 'allow';
    
    return 'deny'; // Default Deny
  }

  private isMatch(condition: MatchCondition, ctx: SyscallContext): boolean {
    // 1. Syscall Type
    if (condition.syscall) {
      const types = Array.isArray(condition.syscall) ? condition.syscall : [condition.syscall];
      if (!types.includes(ctx.type) && !types.includes('*')) return false;
    }

    // 2. Caller Tag
    if (condition.caller_tag) {
      const tags = Array.isArray(condition.caller_tag) ? condition.caller_tag : [condition.caller_tag];
      // Check if ANY required tag is present in caller's tags
      // OR logic for multiple tags in condition: match ANY one
      const match = tags.some(requiredTag => ctx.caller.capabilityTags.includes(requiredTag));
      if (!match) return false;
    }

    // 3. Path Glob (if syscall has path arg)
    if (condition.path_glob && typeof ctx.args['path'] === 'string') {
      const globs = Array.isArray(condition.path_glob) ? condition.path_glob : [condition.path_glob];
      const isMatch = picomatch(globs);
      if (!isMatch(ctx.args['path'] as string)) return false;
    }

    return true;
  }

  private isExcluded(rule: PolicyRule, ctx: SyscallContext): boolean {
    if (!rule.except) return false;
    for (const condition of rule.except) {
      if (this.isMatch(condition, ctx)) return true;
    }
    return false;
  }
}
