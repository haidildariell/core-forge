// The pkt-line codec of the git wire protocol: 4-hex-digit length-prefixed packets,
// flush packets (0000) and delimiter packets (0001).

export class PktError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PktError';
  }
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');

/** Encode one data packet (payload at most 65516 bytes, the length prefix included in the count). */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 0xffff) throw new PktError(`pkt-line payload too large: ${data.length}`);
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export type PktKind = 'data' | 'flush' | 'delim';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** A sequential reader over a request body; `rest` is whatever follows a flush packet. */
export class PktReader {
  private offset = 0;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  /** The next packet, or null at the end of the buffer. Throws PktError on malformed framing. */
  next(): Pkt | null {
    if (this.offset >= this.buffer.length) return null;
    if (this.offset + 4 > this.buffer.length) throw new PktError('truncated pkt-line header');
    const header = this.buffer.toString('ascii', this.offset, this.offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new PktError(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      this.offset += 4;
      return { kind: 'flush', payload: Buffer.alloc(0) };
    }
    if (length === 1) {
      this.offset += 4;
      return { kind: 'delim', payload: Buffer.alloc(0) };
    }
    if (length < 4) throw new PktError(`pkt-line length ${length} is too small`);
    if (this.offset + length > this.buffer.length) throw new PktError('pkt-line overruns the body');
    const payload = this.buffer.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return { kind: 'data', payload };
  }

  /** Everything not yet consumed (the pack after a flush, in receive-pack). */
  get rest(): Buffer {
    return this.buffer.subarray(this.offset);
  }
}

/** Read data packets until a flush (or the buffer's end); the reader stops after the flush. */
export function readUntilFlush(reader: PktReader): Buffer[] {
  const lines: Buffer[] = [];
  for (;;) {
    const packet = reader.next();
    if (packet === null || packet.kind === 'flush') return lines;
    if (packet.kind === 'data') lines.push(packet.payload);
  }
}
