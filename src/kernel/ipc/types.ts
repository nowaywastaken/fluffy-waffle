// src/kernel/ipc/types.ts
export interface PeerIdentity {
  pid: number;
  uid: number;
  gid: number;
}

export interface IpcMessage {
  id: string;
  type: 'request' | 'response' | 'event';
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface RequestContext {
  containerId: string;
  pluginName: string;
  capabilityTags: string[];
  peer: PeerIdentity;
}
