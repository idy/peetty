/** JSON transport pieces never require a string the size of the full archive. */
export function* jsonChunks(value: unknown, chunkChars: number): Generator<string> {
  if (!Number.isSafeInteger(chunkChars) || chunkChars < 8) throw new Error('Invalid or unsupported profile data.');
  function* tokens(item: unknown): Generator<string> {
    if (typeof item === 'string') {
      yield '"';
      for (let offset = 0; offset < item.length; offset += 16_384) yield JSON.stringify(item.slice(offset, offset + 16_384)).slice(1, -1);
      yield '"';
    } else if (Array.isArray(item)) {
      yield '[';
      for (let i = 0; i < item.length; i++) { if (i) yield ','; yield* tokens(item[i] ?? null); }
      yield ']';
    } else if (item && typeof item === 'object') {
      yield '{'; let separator = '';
      for (const field of Object.keys(item)) {
        const child = (item as Record<string, unknown>)[field];
        if (child === undefined) continue;
        yield separator; separator = ',';
        yield* tokens(field); yield ':'; yield* tokens(child);
      }
      yield '}';
    } else yield JSON.stringify(item) ?? 'null';
  }
  let pending = '';
  for (const token of tokens(value)) {
    for (let offset = 0; offset < token.length;) {
      const count = Math.min(chunkChars - pending.length, token.length - offset);
      pending += token.slice(offset, offset + count); offset += count;
      if (pending.length === chunkChars) {
        const last = pending.charCodeAt(pending.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) { yield pending.slice(0, -1); pending = pending.slice(-1); }
        else { yield pending; pending = ''; }
      }
    }
  }
  if (pending) yield pending;
}

type TokenLimit = number | ((path: readonly string[], key: boolean) => number);
interface ParserTesting { onStringBuffers?: (buffers: number, pending: number, decoded: number) => void }
export interface JSONParseOptions {
  collectionLimit?: (path: readonly string[], array: boolean) => number;
  allowedKey?: (path: readonly string[], key: string) => boolean;
  allowedType?: (path: readonly string[], type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null') => boolean;
  validateValue?: (path: readonly string[], value: unknown) => void;
  check?: () => void;
}
interface JSONFrame {
  array: boolean;
  value: unknown[] | Record<string, unknown>;
  state: 'keyOrEnd' | 'key' | 'colon' | 'valueOrEnd' | 'value' | 'commaOrEnd';
  path: readonly string[];
  field: string;
  limit: number;
  count: number;
}
interface StringToken { key: boolean; limit: number; size: number; pieces: string[]; pending: string; escape: boolean; unicode: string | undefined }
const invalidJSON = (): never => { throw new Error('Invalid or unsupported profile data.'); };
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** A push parser shared by synchronous and asynchronous transport. Each feed is
 * consumed synchronously, so escape-heavy tokens never incur per-character awaits.
 * Only decoded schema-bounded strings are joined; no whole-source accumulation. */
class JSONChunkParser {
  private readonly stack: JSONFrame[] = [];
  private root: unknown;
  private complete = false;
  private string: StringToken | undefined;
  private primitive: string | undefined;
  private readonly maxTokenChars: TokenLimit;
  private readonly testing: ParserTesting | undefined;
  private readonly options: JSONParseOptions;
  constructor(maxTokenChars: TokenLimit, testing?: ParserTesting, options: JSONParseOptions = {}) {
    this.maxTokenChars = maxTokenChars; this.testing = testing; this.options = options;
  }
  private path(): readonly string[] {
    const frame = this.stack.at(-1);
    return frame ? [...frame.path, frame.array ? '*' : frame.field] : [];
  }
  private accept(value: unknown): void {
    this.options.validateValue?.(this.path(), value);
    const frame = this.stack.at(-1);
    if (!frame) { if (this.complete) invalidJSON(); this.root = value; this.complete = true; return; }
    if (frame.state !== 'value' && frame.state !== 'valueOrEnd') invalidJSON();
    const newItem = frame.array || !Object.hasOwn(frame.value, frame.field);
    if (newItem && frame.count >= frame.limit) invalidJSON();
    if (newItem) frame.count++;
    if (frame.array) (frame.value as unknown[]).push(value);
    else Object.defineProperty(frame.value, frame.field, { configurable: true, enumerable: true, writable: true, value });
    frame.state = 'commaOrEnd';
  }
  private close(): void { const frame = this.stack.pop()!; this.accept(frame.value); }
  private startString(key: boolean): void {
    const path = key ? this.stack.at(-1)!.path : this.path();
    const limit = typeof this.maxTokenChars === 'number' ? this.maxTokenChars : this.maxTokenChars(path, key);
    this.string = { key, limit, size: 0, pieces: [], pending: '', escape: false, unicode: undefined };
  }
  private append(value: string): void {
    if (!value) return;
    const token = this.string!;
    token.size += value.length; if (token.size > token.limit) invalidJSON();
    for (let offset = 0; offset < value.length;) {
      const count = Math.min(16_384 - token.pending.length, value.length - offset);
      token.pending += value.slice(offset, offset + count); offset += count;
      if (token.pending.length === 16_384) { token.pieces.push(token.pending); token.pending = ''; }
    }
    this.testing?.onStringBuffers?.(token.pieces.length, token.pending.length, token.size);
  }
  private finishPrimitive(): void {
    const primitive = this.primitive!; this.primitive = undefined;
    if (!/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/.test(primitive)) invalidJSON();
    this.accept(JSON.parse(primitive) as unknown);
  }
  feed(source: string): void {
    let offset = 0;
    const special = /["\\\u0000-\u001f]/g;
    const delimiter = /[\x20\t\n\r,\]}]/g;
    const nonspace = /[^\x20\t\n\r]/g;
    while (offset < source.length) {
      const token = this.string;
      if (token) {
        if (token.unicode !== undefined) {
          const char = source[offset++]!;
          if (!/[0-9a-f]/i.test(char)) invalidJSON();
          token.unicode += char;
          if (token.unicode.length === 4) { this.append(String.fromCharCode(Number.parseInt(token.unicode, 16))); token.unicode = undefined; }
          continue;
        }
        if (token.escape) {
          const char = source[offset++]!; token.escape = false;
          if (char === 'u') token.unicode = '';
          else { if (!Object.hasOwn(ESCAPES, char)) invalidJSON(); this.append(ESCAPES[char]!); }
          continue;
        }
        special.lastIndex = offset;
        const match = special.exec(source);
        const end = match?.index ?? source.length;
        this.append(source.slice(offset, end)); offset = end;
        if (!match) continue;
        const char = source[offset++]!;
        if (char === '\\') { token.escape = true; continue; }
        if (char !== '"') invalidJSON();
        if (token.pending) token.pieces.push(token.pending);
        const value = token.pieces.join(''); this.string = undefined;
        if (token.key) {
          const frame = this.stack.at(-1)!;
          if (this.options.allowedKey && !this.options.allowedKey(frame.path, value)) invalidJSON();
          if (!Object.hasOwn(frame.value, value) && frame.count >= frame.limit) invalidJSON();
          frame.field = value; frame.state = 'colon';
        } else this.accept(value);
        continue;
      }
      if (this.primitive !== undefined) {
        delimiter.lastIndex = offset;
        const match = delimiter.exec(source); const end = match?.index ?? source.length;
        if (this.primitive.length + end - offset > 1_024) invalidJSON();
        this.primitive += source.slice(offset, end); offset = end;
        if (match) this.finishPrimitive();
        continue;
      }
      nonspace.lastIndex = offset;
      const next = nonspace.exec(source); if (!next) return;
      offset = next.index;
      const char = source[offset]!; const frame = this.stack.at(-1);
      if (!frame && this.complete) invalidJSON();
      if (frame?.state === 'commaOrEnd') {
        if (char === (frame.array ? ']' : '}')) { offset++; this.close(); continue; }
        if (char !== ',') invalidJSON();
        frame.state = frame.array ? 'value' : 'key'; offset++; continue;
      }
      if (frame?.state === 'colon') {
        if (char !== ':') invalidJSON(); frame.state = 'value'; offset++; continue;
      }
      if (frame && (frame.state === 'keyOrEnd' || frame.state === 'key')) {
        if (char === '}' && frame.state === 'keyOrEnd') { offset++; this.close(); continue; }
        if (char !== '"') invalidJSON(); this.startString(true); offset++; continue;
      }
      if (frame?.state === 'valueOrEnd' && char === ']') { offset++; this.close(); continue; }
      // Reject the first excess item before allocating or parsing its value.
      if (frame?.array && frame.count >= frame.limit) invalidJSON();
      if (this.options.allowedType) {
        const type = char === '{' ? 'object' : char === '[' ? 'array' : char === '"' ? 'string'
          : char === 't' || char === 'f' ? 'boolean' : char === 'n' ? 'null' : 'number';
        if (!this.options.allowedType(this.path(), type)) invalidJSON();
      }
      if (char === '"') { this.startString(false); offset++; continue; }
      if (char === '{' || char === '[') {
        if (this.stack.length >= 128) invalidJSON();
        const array = char === '['; const path = this.path();
        const limit = this.options.collectionLimit?.(path, array) ?? Infinity;
        if (limit < 0) invalidJSON();
        this.stack.push({ array, path, value: array ? [] : {}, state: array ? 'valueOrEnd' : 'keyOrEnd', field: '', limit, count: 0 });
        offset++; continue;
      }
      if (!/[tfn0-9-]/.test(char)) invalidJSON();
      this.primitive = '';
    }
  }
  finish(): unknown {
    if (this.primitive !== undefined) this.finishPrimitive();
    if (this.string || this.stack.length || !this.complete) invalidJSON();
    return this.root;
  }
}

export function parseJSONChunks(chunks: readonly string[], maxTokenChars: TokenLimit, testing?: ParserTesting, options: JSONParseOptions = {}): unknown {
  const parser = new JSONChunkParser(maxTokenChars, testing, options);
  for (const chunk of chunks) {
    for (let offset = 0; offset < chunk.length; offset += 65_536) { options.check?.(); parser.feed(chunk.slice(offset, offset + 65_536)); }
  }
  options.check?.();
  return parser.finish();
}

/** Consume one transport part at a time, releasing its source before requesting
 * the next. The retained object is the decoded backup, not its serialized input. */
export async function parseJSONChunksAsync(chunks: AsyncIterable<string>, maxTokenChars: TokenLimit, testing?: ParserTesting, options: JSONParseOptions = {}): Promise<unknown> {
  const parser = new JSONChunkParser(maxTokenChars, testing, options);
  let batch = 0;
  options.check?.();
  for await (const chunk of chunks) {
    for (let offset = 0; offset < chunk.length; offset += 65_536) {
      options.check?.();
      const piece = chunk.slice(offset, offset + 65_536);
      parser.feed(piece); batch += piece.length;
      if (options.check && batch >= 262_144) {
        batch = 0; await new Promise<void>((resolve) => setTimeout(resolve, 0)); options.check();
      }
    }
  }
  options.check?.();
  return parser.finish();
}

// Incremental SHA-256 provenance. Checkpoints contain digests rather than a second
// plaintext copy of legacy conversations or credentials, including after deletion.
const SHA_K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
export function jsonFingerprint(value: unknown): string {
  const hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const block = new Uint8Array(64); const words = new Uint32Array(64); let filled = 0; let bytes = 0;
  const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  const compress = () => {
    const view = new DataView(block.buffer);
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15]!; const y = words[i - 2]!;
      words[i] = words[i - 16]! + (rotate(x,7) ^ rotate(x,18) ^ (x >>> 3)) + words[i - 7]! + (rotate(y,17) ^ rotate(y,19) ^ (y >>> 10));
    }
    let [a,b,c,d,e,f,g,h] = hash as [number,number,number,number,number,number,number,number];
    for (let i = 0; i < 64; i++) {
      const first = h + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + ((e & f) ^ (~e & g)) + SHA_K[i]! + words[i]!;
      const second = (rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + ((a & b) ^ (a & c) ^ (b & c));
      h=g; g=f; f=e; e=(d+first)|0; d=c; c=b; b=a; a=(first+second)|0;
    }
    for (const [i, item] of [a,b,c,d,e,f,g,h].entries()) hash[i] = (hash[i]! + item) | 0;
  };
  const append = (byte: number) => { block[filled++] = byte; if (filled === 64) { compress(); filled = 0; } };
  // Hash exact UTF-16 code units so piece boundaries cannot replace a surrogate.
  for (const chunk of jsonChunks(value, 16_384)) for (let i = 0; i < chunk.length; i++) {
    const code = chunk.charCodeAt(i); append(code >>> 8); append(code & 255); bytes += 2;
  }
  append(0x80); while (filled !== 56) append(0);
  const length = bytes * 8;
  for (let shift = 7; shift >= 0; shift--) append(Math.floor(length / 2 ** (shift * 8)) & 255);
  return hash.map((word) => (word >>> 0).toString(16).padStart(8, '0')).join('');
}
