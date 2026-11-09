import { createServer, type Server } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamdScannerAdapter, interpretReply } from './clamd-scanner.adapter';

/** Minimal fake clamd: answers VERSION, and INSTREAM with `instreamReply` after the 0-length terminator. */
function fakeClamd(instreamReply: string) {
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    let mode: 'cmd' | 'stream' = 'cmd';
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (mode === 'cmd') {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        const cmd = buf.subarray(0, nul).toString();
        buf = buf.subarray(nul + 1);
        if (cmd === 'zVERSION') {
          socket.end('ClamAV 1.4.1/27500/Tue Nov  4 07:25:12 2026\0');
          return;
        }
        mode = 'stream';
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          socket.end(instreamReply);
          return;
        }
        if (buf.length < 4 + len) return;
        received.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
  });
  return { server, received };
}

let server: Server | undefined;
afterEach(() => server?.close());

async function scanWith(instreamReply: string, body: Buffer, maxScanBytes = 1024) {
  const fake = fakeClamd(instreamReply);
  server = fake.server;
  await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
  const { port } = fake.server.address() as { port: number };
  const adapter = new ClamdScannerAdapter({
    host: '127.0.0.1',
    port,
    timeoutMs: 2000,
    maxScanBytes,
  });
  const result = await adapter.scan(Readable.from([body]), body.length);
  return { result, received: Buffer.concat(fake.received) };
}

describe('ClamdScannerAdapter', () => {
  it('streams the bytes to clamd and reports clean with engine info', async () => {
    const body = Buffer.from('hello build');
    const { result, received } = await scanWith('stream: OK\0', body);

    expect(received.equals(body)).toBe(true);
    expect(result).toEqual({ verdict: 'clean', engine: 'ClamAV 1.4.1', signatures: '27500' });
  });

  it('reports the threat name when clamd finds something', async () => {
    const { result } = await scanWith('stream: Win.Test.EICAR_HDB-1 FOUND\0', Buffer.from('x'));
    expect(result).toMatchObject({ verdict: 'infected', threat: 'Win.Test.EICAR_HDB-1' });
  });

  it('does not send objects over the configured size limit', async () => {
    const { result, received } = await scanWith('stream: OK\0', Buffer.alloc(2000), 1000);
    expect(result.verdict).toBe('unscannable');
    expect(received.length).toBe(0);
  });

  it('returns an error verdict (not a throw) when clamd is unreachable', async () => {
    const adapter = new ClamdScannerAdapter({
      host: '127.0.0.1',
      port: 1,
      timeoutMs: 500,
      maxScanBytes: 1000,
    });
    const result = await adapter.scan(Readable.from([Buffer.from('x')]), 1);
    expect(result.verdict).toBe('error');
  });
});

describe('interpretReply', () => {
  it('treats a limit-exceeded alert as unscannable, never infected or clean', () => {
    expect(
      interpretReply('stream: Heuristics.Limits.Exceeded.MaxFileSize FOUND', 'e', 's').verdict,
    ).toBe('unscannable');
  });

  it('treats the INSTREAM size-limit error as unscannable', () => {
    expect(interpretReply('INSTREAM size limit exceeded. ERROR', 'e', 's').verdict).toBe(
      'unscannable',
    );
  });

  it('treats anything unrecognized as a retryable error', () => {
    expect(interpretReply('', 'e', 's').verdict).toBe('error');
    expect(interpretReply('stream: lstat() failed ERROR', 'e', 's').verdict).toBe('error');
  });
});
