import { createConnection, type Socket } from 'node:net';
import type { Readable } from 'node:stream';
import type { MalwareScannerPort, ScanResult } from '../../shared/ports/malware-scanner.port';

export interface ClamdScannerOptions {
  host: string;
  port: number;
  /** Socket inactivity timeout. clamd is silent while it scans after the last byte is sent. */
  timeoutMs: number;
  /** Objects larger than this are reported `unscannable` without being sent. */
  maxScanBytes: number;
}

/** Piece size written to clamd; each piece is framed with a 4-byte length (INSTREAM protocol). */
const PIECE_BYTES = 1024 * 1024;

/**
 * ClamAV adapter speaking the `clamd` TCP protocol directly (`zINSTREAM`,
 * `zVERSION`) — no client library. The object is streamed to clamd from
 * storage, never buffered in memory and never exposed to a client.
 */
export class ClamdScannerAdapter implements MalwareScannerPort {
  constructor(private readonly options: ClamdScannerOptions) {}

  async scan(stream: Readable, sizeBytes: number): Promise<ScanResult> {
    if (sizeBytes > this.options.maxScanBytes) {
      stream.destroy();
      return {
        verdict: 'unscannable',
        engine: 'ClamAV',
        signatures: 'n/a',
        reason: `Arquivo maior que o limite de verificação (${this.options.maxScanBytes} bytes)`,
      };
    }

    try {
      const { engine, signatures } = await this.version();
      const reply = await this.instream(stream);
      return interpretReply(reply, engine, signatures);
    } catch (err) {
      stream.destroy();
      return { verdict: 'error', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  private connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.options.host, port: this.options.port });
      socket.setTimeout(this.options.timeoutMs);
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error('clamd: timeout ao conectar'));
      });
    });
  }

  /** Resolves with everything clamd sends until it closes the connection. */
  private collectReply(socket: Socket): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      socket.on('data', (c: Buffer) => chunks.push(c));
      socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.once('error', reject);
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error('clamd: timeout aguardando resposta'));
      });
    });
  }

  private async version(): Promise<{ engine: string; signatures: string }> {
    const socket = await this.connect();
    const reply = this.collectReply(socket);
    socket.write('zVERSION\0');
    const text = cleanReply(await reply);
    // "ClamAV 1.4.1/27500/Tue Nov  4 07:25:12 2026"
    const [engine, signatures] = text.split('/');
    if (!engine || !engine.startsWith('ClamAV')) {
      throw new Error(`clamd: resposta inesperada ao VERSION: ${text}`);
    }
    return { engine, signatures: signatures ?? 'unknown' };
  }

  private async instream(stream: Readable): Promise<string> {
    const socket = await this.connect();
    const reply = this.collectReply(socket);
    // Settle-early guard: if clamd answers/aborts mid-upload (size limit), stop writing.
    let replyError: unknown;
    reply.catch((e: unknown) => {
      replyError = e;
    });
    let closed = false;
    socket.once('close', () => {
      closed = true;
    });

    try {
      socket.write('zINSTREAM\0');
      for await (const chunk of stream) {
        if (closed) break;
        const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (let offset = 0; offset < buf.length; offset += PIECE_BYTES) {
          const piece = buf.subarray(offset, offset + PIECE_BYTES);
          const header = Buffer.alloc(4);
          header.writeUInt32BE(piece.length);
          socket.write(header);
          if (!socket.write(piece)) {
            await new Promise<void>((resolve) => {
              const done = () => {
                socket.off('drain', done);
                socket.off('close', done);
                resolve();
              };
              socket.once('drain', done);
              socket.once('close', done);
            });
          }
        }
      }
      if (!closed) socket.write(Buffer.alloc(4)); // zero-length chunk terminates the stream
    } catch (err) {
      socket.destroy();
      throw err;
    } finally {
      stream.destroy();
    }

    const text = await reply;
    if (replyError) throw replyError;
    return cleanReply(text);
  }
}

function cleanReply(raw: string): string {
  return raw.replace(/\0/g, '').trim();
}

/** Maps clamd's one-line reply ("stream: OK" / "stream: <sig> FOUND" / "... ERROR") to a verdict. */
export function interpretReply(reply: string, engine: string, signatures: string): ScanResult {
  if (reply === 'stream: OK') return { verdict: 'clean', engine, signatures };

  const found = /^stream: (.+) FOUND$/.exec(reply);
  if (found) {
    const threat = found[1];
    // clamd (AlertExceedsMax yes) reports a truncated scan as a signature hit.
    if (threat.startsWith('Heuristics.Limits.Exceeded')) {
      return {
        verdict: 'unscannable',
        engine,
        signatures,
        reason: 'Arquivo excede os limites de verificação do scanner (tamanho/profundidade)',
      };
    }
    return { verdict: 'infected', engine, signatures, threat };
  }

  if (/size limit exceeded/i.test(reply)) {
    return {
      verdict: 'unscannable',
      engine,
      signatures,
      reason: 'Arquivo excede o tamanho máximo aceito pelo scanner',
    };
  }

  return { verdict: 'error', reason: `clamd: resposta inesperada: ${reply || '(vazia)'}` };
}
