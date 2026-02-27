// src/kernel/ipc/protocol.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolHandler } from './protocol.ts';
import type { IpcMessage } from './types.ts';

describe('ProtocolHandler', () => {
  it('encode/decode round-trip', () => {
    const msg: IpcMessage = { id: '1', type: 'request', method: 'test.ping', params: {} };
    const encoded = ProtocolHandler.encode(msg);
    const handler = new ProtocolHandler();
    const decoded = handler.handleData(encoded);
    assert.deepStrictEqual(decoded, [msg]);
  });

  it('returns empty array when data is less than 4 bytes', () => {
    const handler = new ProtocolHandler();
    assert.deepStrictEqual(handler.handleData(Buffer.alloc(2)), []);
  });

  it('returns empty array when payload is incomplete', () => {
    const handler = new ProtocolHandler();
    const msg: IpcMessage = { id: '2', type: 'request', method: 'test.ping', params: {} };
    const encoded = ProtocolHandler.encode(msg);
    // Feed header + 1 byte only
    assert.deepStrictEqual(handler.handleData(encoded.subarray(0, 5)), []);
  });

  it('assembles message from two chunks', () => {
    const handler = new ProtocolHandler();
    const msg: IpcMessage = { id: '3', type: 'request', method: 'test.ping', params: {} };
    const encoded = ProtocolHandler.encode(msg);
    const mid = Math.floor(encoded.length / 2);
    handler.handleData(encoded.subarray(0, mid));
    const result = handler.handleData(encoded.subarray(mid));
    assert.deepStrictEqual(result, [msg]);
  });

  it('parses multiple messages from one chunk', () => {
    const handler = new ProtocolHandler();
    const msg1: IpcMessage = { id: '4', type: 'request', method: 'a', params: {} };
    const msg2: IpcMessage = { id: '5', type: 'response', result: 42 };
    const combined = Buffer.concat([ProtocolHandler.encode(msg1), ProtocolHandler.encode(msg2)]);
    assert.deepStrictEqual(handler.handleData(combined), [msg1, msg2]);
  });

  it('drops malformed JSON frame and continues with next valid frame', () => {
    const handler = new ProtocolHandler();
    const bad = Buffer.from('not json', 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(bad.length, 0);
    const badFrame = Buffer.concat([header, bad]);
    const good: IpcMessage = { id: '6', type: 'request', method: 'test.ping', params: {} };
    const combined = Buffer.concat([badFrame, ProtocolHandler.encode(good)]);
    assert.deepStrictEqual(handler.handleData(combined), [good]);
  });
});
