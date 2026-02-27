import type { SandboxState } from './types.ts';

const VALID_TRANSITIONS: Record<SandboxState, SandboxState[]> = {
  creating:  ['running', 'failed'],
  running:   ['stopping', 'failed'],
  stopping:  ['cleanup'],
  cleanup:   ['destroyed'],
  failed:    ['cleanup'],
  destroyed: [],
};

export class SandboxLifecycle {
  private states = new Map<string, SandboxState>();

  transition(id: string, next: SandboxState): void {
    const current = this.states.get(id) ?? 'creating';
    const allowed = VALID_TRANSITIONS[current];
    if (!allowed.includes(next)) {
      throw new Error(`Invalid transition: ${current} -> ${next} for sandbox ${id}`);
    }
    this.states.set(id, next);
  }

  get(id: string): SandboxState {
    return this.states.get(id) ?? 'destroyed';
  }

  active(): string[] {
    return [...this.states.entries()]
      .filter(([, state]) => state !== 'destroyed')
      .map(([id]) => id);
  }

  delete(id: string): void {
    this.states.delete(id);
  }
}
