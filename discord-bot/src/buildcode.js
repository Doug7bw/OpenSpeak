// Código de build do Deadlock (o que se cola no jogo para importar uma build):
// base64( zstd( protobuf CMsgHeroBuild ) ). Esquema: citadel_gcmessages_common.proto
// (SteamDatabase/GameTracking-Deadlock). Testado no jogo: o import só exige
// hero_build_id diferente de zero; autor e versão são opcionais.

import zlib from 'node:zlib';

/** Escritor mínimo de protobuf (só o que o CMsgHeroBuild usa). */
class Writer {
  constructor() { this.parts = []; }
  raw(bytes) { this.parts.push(Buffer.from(bytes)); }
  varint(n) {
    let v = BigInt.asUintN(64, BigInt(n)); // int32 negativo vira 10 bytes, como no protobuf
    const out = [];
    do {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if (v) b |= 0x80;
      out.push(b);
    } while (v);
    this.raw(out);
  }
  key(field, wire) { this.varint((field << 3) | wire); }
  uint(field, v) { if (v != null) { this.key(field, 0); this.varint(v); } }
  bool(field, v) { if (v != null) { this.key(field, 0); this.varint(v ? 1 : 0); } }
  float(field, v) {
    if (v == null) return;
    const b = Buffer.alloc(4);
    b.writeFloatLE(v);
    this.key(field, 5);
    this.raw(b);
  }
  bytes(field, buf) { this.key(field, 2); this.varint(buf.length); this.raw(buf); }
  str(field, s) { if (s != null) this.bytes(field, Buffer.from(String(s), 'utf8')); }
  msg(field, writer) { this.bytes(field, writer.buffer()); }
  buffer() { return Buffer.concat(this.parts); }
}

function modEntry(m) {
  const w = new Writer();
  w.uint(1, m.ability_id);
  w.str(2, m.annotation);
  w.uint(3, m.required_flex_slots);
  w.uint(4, m.sell_priority);
  w.uint(5, m.imbue_target_ability_id);
  return w;
}

function modCategory(c) {
  const w = new Writer();
  for (const m of c.mods ?? []) w.msg(1, modEntry(m));
  w.str(2, c.name);
  w.str(3, c.description);
  w.float(4, c.width);
  w.float(5, c.height);
  w.bool(6, c.optional);
  return w;
}

function currencyChange(c) {
  const w = new Writer();
  w.uint(1, c.ability_id);
  w.uint(2, c.currency_type);
  w.uint(3, c.delta);
  w.str(4, c.annotation);
  return w;
}

/** CMsgHeroBuild (o objeto `hero_build` da deadlock-api) -> bytes do protobuf. */
export function encodeHeroBuild(b) {
  const w = new Writer();
  w.uint(1, b.hero_build_id || 1); // o jogo recusa sem ID; qualquer valor ≠ 0 serve
  w.uint(2, b.hero_id);
  w.uint(3, b.author_account_id);
  w.uint(4, b.last_updated_timestamp);
  w.str(5, b.name);
  w.str(6, b.description);
  w.uint(7, b.language);
  w.uint(8, b.version);
  w.uint(9, b.origin_build_id);
  if (b.details) {
    const d = new Writer();
    for (const c of b.details.mod_categories ?? []) d.msg(1, modCategory(c));
    if (b.details.ability_order) {
      const o = new Writer();
      for (const c of b.details.ability_order.currency_changes ?? []) o.msg(1, currencyChange(c));
      d.msg(2, o);
    }
    w.msg(10, d);
  }
  for (const t of b.tags ?? []) w.uint(11, t);
  w.bool(12, b.development_build);
  w.uint(13, b.publish_timestamp);
  return w.buffer();
}

/**
 * Quadro zstd sem compressão (blocos "raw"): qualquer decodificador zstd aceita.
 * Plano B para Node sem zlib.zstdCompressSync (antes do 22.15).
 */
export function zstdRawFrame(data) {
  const parts = [Buffer.from([0x28, 0xb5, 0x2f, 0xfd])];
  // Single segment + tamanho do conteúdo (1, 2 ou 4 bytes), sem checksum nem dicionário.
  let fcs;
  if (data.length < 256) {
    parts.push(Buffer.from([0x20]));
    fcs = Buffer.from([data.length]);
  } else if (data.length < 65536 + 256) {
    parts.push(Buffer.from([0x60]));
    fcs = Buffer.alloc(2);
    fcs.writeUInt16LE(data.length - 256);
  } else {
    parts.push(Buffer.from([0xa0]));
    fcs = Buffer.alloc(4);
    fcs.writeUInt32LE(data.length);
  }
  parts.push(fcs);
  const MAX_BLOCK = 128 * 1024;
  let offset = 0;
  do {
    const size = Math.min(MAX_BLOCK, data.length - offset);
    const last = offset + size >= data.length ? 1 : 0;
    const header = (size << 3) | (0 << 1) | last; // tipo 0 = raw
    parts.push(Buffer.from([header & 0xff, (header >> 8) & 0xff, (header >> 16) & 0xff]));
    parts.push(data.subarray(offset, offset + size));
    offset += size;
  } while (offset < data.length);
  return Buffer.concat(parts);
}

export function zstdCompress(data) {
  if (typeof zlib.zstdCompressSync === 'function') {
    return zlib.zstdCompressSync(data, {
      params: { [zlib.constants.ZSTD_c_compressionLevel]: 19, [zlib.constants.ZSTD_c_checksumFlag]: 1 },
    });
  }
  return zstdRawFrame(data);
}

/** Código pronto para colar no jogo. */
export function buildCode(heroBuild) {
  return zstdCompress(encodeHeroBuild(heroBuild)).toString('base64');
}
