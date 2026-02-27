// src/bootstrap/health-check.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolHandler } from '../kernel/ipc/protocol.ts';
import type { IpcMessage } from '../kernel/ipc/types.ts';

// Copy of the helpers to be added to bootstrap/index.ts
// Having them here validates the encoding before we modify the source

function buildPingFrame(): Buffer {
  const msg: IpcMessage = {
    id: 'bootstrap-ping-1',
    type: 'request',
    method: 'test.ping',
    params: {},
  };
  const payload = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function parsePongFrame(data: Buffer): boolean {
  if (data.length < 4) return false;
  const length = data.readUInt32BE(0);
  if (data.length < 4 + length) return false;
  try {
    const msg = JSON.parse(data.subarray(4, 4 + length).toString('utf8'));
    return msg.type === 'response' && msg.result?.pong === true;
  } catch {
    return false;
  }
}

describe('Bootstrap health check frame helpers', () => {
  it('buildPingFrame produces a valid IPC frame', () => {
    const frame = buildPingFrame();
    assert.ok(frame.length > 4);
    const length = frame.readUInt32BE(0);
    assert.strictEqual(frame.length, 4 + length);
  });

  it('buildPingFrame encodes correct method and type', () => {
    const frame = buildPingFrame();
    const handler = new ProtocolHandler();
    const msgs = handler.handleData(frame);
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].method, 'test.ping');
    assert.strictEqual(msgs[0].type, 'request');
  });

  it('parsePongFrame returns true for valid pong response', () => {
    const pong: IpcMessage = { id: '1', type: 'response', result: { pong: true } };
    const frame = ProtocolHandler.encode(pong);
    assert.strictEqual(parsePongFrame(frame), true);
  });

  it('parsePongFrame returns false for data shorter than 4 bytes', () => {
    assert.strictEqual(parsePongFrame(Buffer.alloc(2)), false);
  });

  it('parsePongFrame returns false when result.pong is not true', () => {
    const notPong: IpcMessage = { id: '2', type: 'response', result: { pong: false } };
    const frame = ProtocolHandler.encode(notPong);
    assert.strictEqual(parsePongFrame(frame), false);
  });

  it('parsePongFrame returns false for malformed JSON', () => {
    const bad = Buffer.from('bad json', 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(bad.length, 0);
    assert.strictEqual(parsePongFrame(Buffer.concat([header, bad])), false);
  });
});
