// src/kernel/security/types.ts
import type { PeerIdentity } from '../ipc/types.ts';

export interface CapabilityTokenClaim {
  tokenId: string;
  containerId: string;
  peerPid: number;
  syscall: string;
  pathGlob?: string[];
  maxOps: number;
  expiresAt: number;   // Unix timestamp ms
  nonce: number;       // monotonically increasing, replay prevention
  signature: string;   // HMAC-SHA256(all other fields, kernelSecret)
}

export interface SyscallContext {
  type: string;
  args: Record<string, unknown>;
  caller: {
    containerId: string;
    pluginName: string;
    capabilityTags: string[];
    peer: PeerIdentity;
  };
  token?: CapabilityTokenClaim;
}

export interface MatchCondition {
  syscall?: string | string[];
  caller_tag?: string | string[];
  path_glob?: string | string[];
  [key: string]: unknown;
}

export interface PolicyRule {
  name: string;
  match: MatchCondition;
  action: 'allow' | 'deny' | 'require_review';
  except?: MatchCondition[];
  reason?: string;
  constraints?: Record<string, unknown>;
}

// Internal: rule with pre-compiled glob patterns
export interface CompiledRule extends PolicyRule {
  _pathMatcher?: (path: string) => boolean;
  _exceptMatchers?: Array<(path: string) => boolean>;
}

export type PolicyDecision = 'allow' | 'deny' | 'require_review' | 'pass';
