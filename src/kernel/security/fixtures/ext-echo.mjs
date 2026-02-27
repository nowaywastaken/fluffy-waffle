// src/kernel/security/fixtures/ext-echo.mjs
// Simulates a Deno extension: connects to Unix socket, responds 'pass' to all ext.evaluate
import net from 'net';

const socketPath = process.argv[2];
const client = net.createConnection(socketPath);

function encode(msg) {
  const payload = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

let buf = Buffer.alloc(0);
client.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const length = buf.readUInt32BE(0);
    if (buf.length < 4 + length) break;
    const payload = buf.subarray(4, 4 + length);
    buf = buf.subarray(4 + length);
    try {
      const msg = JSON.parse(payload.toString('utf8'));
      if (msg.type === 'request' && msg.method === 'ext.evaluate') {
        client.write(encode({ id: msg.id, type: 'response', result: 'pass' }));
      }
    } catch {}
  }
});
client.on('error', () => process.exit(1));
client.on('close', () => process.exit(0));
