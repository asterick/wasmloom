const utf8 = new TextEncoder();

/** Growable little-endian byte buffer with LEB128 primitives. */
export class ByteWriter {
  constructor() {
    this.buf = new Uint8Array(256);
    this.len = 0;
  }

  ensure(n) {
    if (this.len + n > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
  }

  u8(v) {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  bytes(arr) {
    this.ensure(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
    return this;
  }

  /** Unsigned LEB128, 32-bit. */
  u32(v) {
    v >>>= 0;
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v !== 0) b |= 0x80;
      this.u8(b);
    } while (v !== 0);
    return this;
  }

  /** Signed LEB128, 32-bit. */
  s32(v) {
    v |= 0;
    for (;;) {
      const b = v & 0x7f;
      v >>= 7;
      if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) {
        this.u8(b);
        return this;
      }
      this.u8(b | 0x80);
    }
  }

  /** Signed LEB128, 64-bit. @param {bigint} v */
  s64(v) {
    for (;;) {
      const b = Number(v & 0x7fn);
      v >>= 7n;
      if ((v === 0n && (b & 0x40) === 0) || (v === -1n && (b & 0x40) !== 0)) {
        this.u8(b);
        return this;
      }
      this.u8(b | 0x80);
    }
  }

  f32(v) {
    this.ensure(4);
    new DataView(this.buf.buffer).setFloat32(this.len, Math.fround(v), true);
    this.len += 4;
    return this;
  }

  f64(v) {
    this.ensure(8);
    new DataView(this.buf.buffer).setFloat64(this.len, v, true);
    this.len += 8;
    return this;
  }

  /** Length-prefixed UTF-8 name. */
  name(s) {
    const b = utf8.encode(s);
    this.u32(b.length);
    return this.bytes(b);
  }

  /** Length-prefixed vector: writes count, then fn(writer, item) per item. */
  vec(items, fn) {
    this.u32(items.length);
    for (const item of items) fn(this, item);
    return this;
  }

  /** Section wrapper: id byte + size-prefixed payload built by fn(sub). Skipped if payload is empty. */
  section(id, fn) {
    const sub = new ByteWriter();
    fn(sub);
    if (sub.len === 0) return this;
    this.u8(id);
    this.u32(sub.len);
    return this.bytes(sub.toBytes());
  }

  toBytes() {
    return this.buf.slice(0, this.len);
  }
}
