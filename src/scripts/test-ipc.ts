import * as net from 'net';
import * as path from 'node:path';

// Simplified protocol handler for test client
class ProtocolHandler {
  private buffer: Buffer = Buffer.alloc(0);

  public handleData(chunk: Buffer): any[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: any[] = [];

    while (true) {
      if (this.buffer.length < 4) break;
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + length) break;

      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);

      try {
        const json = JSON.parse(payload.toString('utf8'));
        messages.push(json);
      } catch (e) {
        console.error('Parse Error:', e);
      }
    }
    return messages;
  }
}

async function main() {
  const socketPath = process.env.FLUFFY_KERNEL_SOCKET || path.join(process.cwd(), '.fluffy', 'ipc', 'kernel.sock');
  console.log(`Testing connection to Kernel IPC at ${socketPath}...`);

  const client = net.createConnection(socketPath);
  const handler = new ProtocolHandler();

  client.on('connect', () => {
    console.log('✅ Connected to Kernel IPC!');
    
    // Construct a test message
    const payload = JSON.stringify({
      id: 'test-req-1',
      type: 'request',
      method: 'test.ping',
      params: { hello: 'world' }
    });
    
    const buffer = Buffer.from(payload, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(buffer.length, 0);
    
    const packet = Buffer.concat([header, buffer]);
    
    console.log('Sending ping request...');
    client.write(packet);
  });

  client.on('data', (chunk) => {
    if (typeof chunk === 'string') {
      chunk = Buffer.from(chunk);
    }
    const responses = handler.handleData(chunk);
    for (const res of responses) {
      console.log('📩 Received Response:', JSON.stringify(res, null, 2));
      if (res.id === 'test-req-1' && res.result && res.result.pong) {
        console.log('✅ Ping/Pong successful!');
        client.end();
        process.exit(0);
      }
    }
  });

  client.on('error', (err) => {
    console.error('❌ Connection failed:', err.message);
    process.exit(1);
  });
}

main();
