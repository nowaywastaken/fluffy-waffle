// src/kernel/ipc/protocol.ts
import type { IpcMessage } from './types.ts';

export class ProtocolHandler {
  private buffer = Buffer.alloc(0);

  handleData(chunk: Buffer): IpcMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: IpcMessage[] = [];
    while (true) {
      if (this.buffer.length < 4) break;
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + length) break;
      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      try {
        messages.push(JSON.parse(payload.toString('utf8')));
      } catch {
        console.error('IPC: malformed frame, dropping');
      }
    }
    return messages;
  }

  static encode(message: IpcMessage): Buffer {
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    return Buffer.concat([header, payload]);
  }
}
