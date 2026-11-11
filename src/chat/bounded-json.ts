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

/** Incremental reader for existing fragmented multipart JSON. Only individual JSON
 * strings are assembled; arrays/objects are constructed directly from the pieces. */
export function parseJSONChunks(
  chunks: readonly string[],
  maxTokenChars: number | ((path: readonly string[], key: boolean) => number),
  testing?: { onStringBuffers?: (buffers: number, pending: number, decoded: number) => void },
): unknown {
  let part = 0; let offset = 0;
  const invalid = (): never => { throw new Error('Invalid or unsupported profile data.'); };
  const peek = (): string => {
    while (part < chunks.length && offset === chunks[part]!.length) { part++; offset = 0; }
    return chunks[part]?.[offset] ?? '';
  };
  const take = (): string => { const result = peek(); if (result) offset++; return result; };
  const space = () => { while (/[\x20\t\n\r]/.test(peek()) && peek()) offset++; };
  const string = (path: readonly string[], key = false): string => {
    if (take() !== '"') invalid();
    const limit = typeof maxTokenChars === 'number' ? maxTokenChars : maxTokenChars(path, key);
    const pieces: string[] = []; let size = 0; let pending = '';
    const append = (value: string) => {
      if (!value) return;
      size += value.length; if (size > limit) invalid();
      for (let offset = 0; offset < value.length;) {
        const count = Math.min(16_384 - pending.length, value.length - offset);
        pending += value.slice(offset, offset + count); offset += count;
        if (pending.length === 16_384) { pieces.push(pending); pending = ''; }
      }
      testing?.onStringBuffers?.(pieces.length, pending.length, size);
    };
    const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    while (peek()) {
      const source = chunks[part]!;
      const special = /["\\\u0000-\u001f]/g; special.lastIndex = offset;
      const match = special.exec(source);
      if (!match) { append(source.slice(offset)); offset = source.length; continue; }
      append(source.slice(offset, match.index)); offset = match.index;
      const char = take();
      if (char === '"') { if (pending) pieces.push(pending); return pieces.join(''); }
      if (char !== '\\') invalid();
      const escape = take();
      if (escape === 'u') {
        let code = '';
        for (let i = 0; i < 4; i++) { const hex = take(); if (!hex || !/[0-9a-f]/i.test(hex)) invalid(); code += hex; }
        append(String.fromCharCode(Number.parseInt(code, 16)));
      } else {
        if (!Object.hasOwn(escapes, escape)) invalid();
        append(escapes[escape]!);
      }
    }
    return invalid();
  };
  const value = (depth: number, path: readonly string[] = []): unknown => {
    if (depth > 128) invalid();
    space(); const char = peek();
    if (char === '"') return string(path);
    if (char === '{' || char === '[') {
      take(); space();
      const array = char === '['; const close = array ? ']' : '}';
      const result: unknown[] | Record<string, unknown> = array ? [] : {};
      if (peek() === close) { take(); return result; }
      while (true) {
        space(); let field = '';
        if (!array) { field = string(path, true); space(); if (take() !== ':') invalid(); }
        const child = value(depth + 1, [...path, array ? '*' : field]);
        if (array) (result as unknown[]).push(child);
        else Object.defineProperty(result, field, { configurable: true, enumerable: true, writable: true, value: child });
        space(); const separator = take();
        if (separator === close) return result;
        if (separator !== ',') invalid();
      }
    }
    let primitive = '';
    while (peek() && !/[\x20\t\n\r,\]}]/.test(peek())) { primitive += take(); if (primitive.length > 1_024) invalid(); }
    if (!/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/.test(primitive)) invalid();
    try { return JSON.parse(primitive) as unknown; } catch { return invalid(); }
  };
  const result = value(0); space(); if (peek()) invalid(); return result;
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
