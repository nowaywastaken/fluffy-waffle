// src/kernel/ipc/peer.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getPeerIdentity } from './peer.ts';

describe('getPeerIdentity', () => {
  it('throws when socket has no handle', () => {
    const mockSocket = { _handle: null } as any;
    assert.throws(
      () => getPeerIdentity(mockSocket),
      (err: Error) => {
        assert.ok(err.message.startsWith('Peer identity verification failed:'), err.message);
        assert.ok(err.message.includes('Socket handle not available'), err.message);
        return true;
      }
    );
  });

  it('throws when socket handle has negative fd', () => {
    const mockSocket = { _handle: { fd: -1 } } as any;
    assert.throws(
      () => getPeerIdentity(mockSocket),
      (err: Error) => {
        assert.ok(err.message.startsWith('Peer identity verification failed:'), err.message);
        assert.ok(err.message.includes('Socket handle not available'), err.message);
        return true;
      }
    );
  });

  it('wraps native errors with "Peer identity verification failed:" prefix', () => {
    // fd 999 is very unlikely to be a valid Unix socket.
    // Either addon is unavailable (throws "not available") or getsockopt fails.
    // Either way, getPeerIdentity must wrap it.
    const mockSocket = { _handle: { fd: 999 } } as any;
    assert.throws(
      () => getPeerIdentity(mockSocket),
      (err: Error) => {
        assert.ok(err.message.startsWith('Peer identity verification failed:'), err.message);
        return true;
      }
    );
  });
});
