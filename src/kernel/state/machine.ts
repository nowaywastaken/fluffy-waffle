import picomatch from 'picomatch';
import {
  EXEMPT_PATTERNS,
  INITIAL_SESSION_STATE,
  TEST_FILE_PATTERNS,
} from './types.ts';
import type {
  SessionMode,
  SessionState,
  TddState,
  ToolGateQuery,
  ToolName,
} from './types.ts';

function cloneState(state: SessionState): SessionState {
  return {
    ...state,
    test_files: [...state.test_files],
  };
}

const READ_TOOLS = new Set<ToolName>(['fs.read', 'fs.list', 'fs.exists', 'search.grep', 'search.glob']);
const TEST_WRITABLE = new Set<ToolName>(['fs.write']);

interface AuditSink {
  log(entry: {
    category: 'policy' | 'tool' | 'ai' | 'lifecycle' | 'error';
    action: string;
    actor: string;
    detail: Record<string, unknown>;
    decision?: 'allow' | 'deny' | 'require_review' | null;
  }): void;
}

export class TddStateMachine {
  private readonly audit: AuditSink;
  private state: SessionState = cloneState(INITIAL_SESSION_STATE);

  private readonly testMatchers = TEST_FILE_PATTERNS.map(pattern => picomatch(pattern, { dot: true }));
  private readonly exemptMatchers = EXEMPT_PATTERNS.map(pattern => picomatch(pattern, { dot: true }));

  constructor(audit: AuditSink) {
    this.audit = audit;
  }

  getState(): SessionState {
    return cloneState(this.state);
  }

  getMode(): SessionMode {
    return this.state.mode;
  }

  hydrate(state: SessionState): void {
    this.state = cloneState(state);
    this.audit.log({
      category: 'lifecycle',
      action: 'state.hydrate',
      actor: 'kernel',
      detail: {
        state: this.state.state,
        mode: this.state.mode,
      },
      decision: 'allow',
    });
  }

  submitTask(): void {
    this.transition('idle', 'planning', 'submit_task');
  }

  completePlanning(): void {
    this.transition('planning', 'test_writing', 'complete_planning');
  }

  completeTestWriting(): void {
    if (this.state.state !== 'test_writing') {
      this.failTransition(`Cannot complete test writing from state: ${this.state.state}`);
    }
    if (this.state.test_files.length === 0) {
      this.failTransition('Cannot run tests before at least one test file is registered');
    }

    this.state.previous_state = 'test_writing';
    this.state.state = 'test_running';
    this.auditTransition('complete_test_writing', 'test_running');
  }

  reportTestResult(passed: boolean): void {
    if (this.state.state !== 'test_running') {
      this.failTransition(`Cannot report test result from state: ${this.state.state}`);
    }

    this.state.last_test_passed = passed;

    if (passed) {
      this.state.consecutive_failures = 0;
      if (this.state.previous_state === 'coding') {
        this.state.state = 'done';
        this.auditTransition('report_test_result', 'done');
        return;
      }

      if (this.state.previous_state === 'test_writing') {
        this.state.state = 'test_writing';
        this.auditTransition('report_test_result', 'test_writing');
        return;
      }

      this.failTransition('Invalid previous_state for passed test result');
    }

    this.state.consecutive_failures += 1;
    this.state.state = 'coding';
    if (this.state.consecutive_failures >= 3) {
      this.audit.log({
        category: 'lifecycle',
        action: 'state.consecutive_failures_high',
        actor: 'kernel',
        detail: {
          consecutive_failures: this.state.consecutive_failures,
          mode: this.state.mode,
        },
        decision: 'require_review',
      });
    }

    this.auditTransition('report_test_result', 'coding');
  }

  completeCoding(): void {
    if (this.state.state !== 'coding') {
      this.failTransition(`Cannot complete coding from state: ${this.state.state}`);
    }

    this.state.previous_state = 'coding';
    this.state.state = 'test_running';
    this.auditTransition('complete_coding', 'test_running');
  }

  reset(): void {
    this.state = cloneState(INITIAL_SESSION_STATE);
    this.auditTransition('reset', 'idle');
  }

  setMode(mode: SessionMode): void {
    this.state.mode = mode;
    this.audit.log({
      category: 'lifecycle',
      action: 'state.mode_set',
      actor: 'kernel',
      detail: { mode },
      decision: 'allow',
    });
  }

  isToolAllowed(query: ToolGateQuery): { allowed: boolean; reason?: string } {
    if (this.state.mode === 'debug') return { allowed: true };

    if (this.state.mode === 'explore') {
      if (READ_TOOLS.has(query.tool)) return { allowed: true };
      return { allowed: false, reason: `Tool ${query.tool} is blocked in explore mode` };
    }

    const effectiveState = this.getEffectiveState();
    switch (effectiveState) {
      case 'idle':
      case 'done':
        return { allowed: false, reason: `Tool ${query.tool} is blocked in ${effectiveState} state` };

      case 'planning':
        if (READ_TOOLS.has(query.tool)) return { allowed: true };
        return { allowed: false, reason: `Tool ${query.tool} is blocked in planning state` };

      case 'test_writing':
        if (READ_TOOLS.has(query.tool)) return { allowed: true };
        if (TEST_WRITABLE.has(query.tool)) {
          if (!query.target_path) {
            return { allowed: false, reason: 'target_path is required for fs.write gate checks' };
          }
          if (this.isTestFile(query.target_path)) return { allowed: true };
          return { allowed: false, reason: 'Cannot write source files in TEST_WRITING state' };
        }
        return { allowed: false, reason: `Tool ${query.tool} is blocked in test_writing state` };

      case 'test_running':
        if (query.tool === 'test.run') return { allowed: true };
        return { allowed: false, reason: `Only test.run is allowed in test_running state` };

      case 'coding':
        if (READ_TOOLS.has(query.tool)) return { allowed: true };
        if (query.tool === 'fs.write') {
          if (!query.target_path) {
            return { allowed: false, reason: 'target_path is required for fs.write gate checks' };
          }
          if (this.isExemptFile(query.target_path)) return { allowed: true };
          if (!this.isTestFile(query.target_path)) return { allowed: true };
          return { allowed: false, reason: 'Cannot write test files in CODING state' };
        }
        return { allowed: false, reason: `Tool ${query.tool} is blocked in coding state` };

      case 'failed':
        return { allowed: false, reason: 'State machine is in failed state; reset is required' };

      default:
        return { allowed: false, reason: `Unsupported state: ${String(effectiveState)}` };
    }
  }

  registerTestFile(path: string): void {
    if (!this.isTestFile(path)) return;
    if (!this.state.test_files.includes(path)) {
      this.state.test_files.push(path);
    }
  }

  isTestFile(path: string): boolean {
    return this.testMatchers.some(match => match(path));
  }

  isExemptFile(path: string): boolean {
    return this.exemptMatchers.some(match => match(path));
  }

  private transition(from: TddState, to: TddState, action: string): void {
    if (this.state.state !== from) {
      this.failTransition(`Invalid transition ${from} -> ${to} from ${this.state.state}`);
    }

    this.state.state = to;
    this.auditTransition(action, to);
  }

  private failTransition(reason: string): never {
    const previous = this.state.state;
    this.state.state = 'failed';
    this.state.previous_state = previous;

    this.audit.log({
      category: 'error',
      action: 'state.transition_failed',
      actor: 'kernel',
      detail: { reason, previous_state: previous },
      decision: 'deny',
    });

    throw new Error(reason);
  }

  private auditTransition(action: string, to: TddState): void {
    this.audit.log({
      category: 'lifecycle',
      action: `state.${action}`,
      actor: 'kernel',
      detail: {
        state: to,
        mode: this.state.mode,
        consecutive_failures: this.state.consecutive_failures,
      },
      decision: 'allow',
    });
  }

  private getEffectiveState(): TddState {
    if (this.state.state !== 'failed') return this.state.state;

    if (this.state.previous_state === 'coding') return 'coding';
    if (this.state.previous_state === 'test_writing' || this.state.previous_state === 'test_running') {
      return 'test_writing';
    }

    return 'failed';
  }
}
