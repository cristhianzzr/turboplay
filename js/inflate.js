/*
 * Gunzip en JavaScript puro (algoritmo inflate al estilo "puff").
 * Se usa para leer la guía XMLTV (.xml.gz) sin depender de librerías externas
 * ni de DecompressionStream (que no existe en TVs antiguas).
 *
 * window.Gunzip.gunzip(Uint8Array) -> Uint8Array
 */
(function () {
  var LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function buildHuffman(lengths, offset, n) {
    var count = new Uint16Array(16);
    var symbol = new Uint16Array(n);
    var offs = new Uint16Array(16);
    var i, len;
    for (i = 0; i < n; i++) count[lengths[offset + i]]++;
    offs[1] = 0;
    for (len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len];
    for (i = 0; i < n; i++) {
      var l = lengths[offset + i];
      if (l !== 0) symbol[offs[l]++] = i;
    }
    return { count: count, symbol: symbol };
  }

  var fixedLit = null, fixedDist = null;
  function buildFixed() {
    if (fixedLit) return;
    var lengths = new Uint8Array(288);
    var i;
    for (i = 0; i < 144; i++) lengths[i] = 8;
    for (; i < 256; i++) lengths[i] = 9;
    for (; i < 280; i++) lengths[i] = 7;
    for (; i < 288; i++) lengths[i] = 8;
    fixedLit = buildHuffman(lengths, 0, 288);
    var d = new Uint8Array(30);
    for (i = 0; i < 30; i++) d[i] = 5;
    fixedDist = buildHuffman(d, 0, 30);
  }

  function inflate(data, start, expectedSize) {
    var pos = start;
    var bitBuf = 0, bitCnt = 0;
    var out = new Uint8Array(Math.max(expectedSize || 0, 1024));
    var outPos = 0;

    function bits(need) {
      var val = bitBuf;
      while (bitCnt < need) {
        if (pos >= data.length) throw new Error("gzip: datos incompletos");
        val |= data[pos++] << bitCnt;
        bitCnt += 8;
      }
      bitBuf = val >>> need;
      bitCnt -= need;
      return val & ((1 << need) - 1);
    }

    function decode(h) {
      var code = 0, first = 0, index = 0;
      for (var len = 1; len <= 15; len++) {
        code |= bits(1);
        var count = h.count[len];
        if (code - count < first) return h.symbol[index + (code - first)];
        index += count;
        first += count;
        first <<= 1;
        code <<= 1;
      }
      throw new Error("gzip: código inválido");
    }

    function ensure(extra) {
      if (outPos + extra <= out.length) return;
      var size = out.length * 2;
      while (size < outPos + extra) size *= 2;
      var bigger = new Uint8Array(size);
      bigger.set(out.subarray(0, outPos));
      out = bigger;
    }

    function codes(lit, dist) {
      for (;;) {
        var sym = decode(lit);
        if (sym < 256) {
          if (outPos >= out.length) ensure(1);
          out[outPos++] = sym;
        } else if (sym === 256) {
          return;
        } else {
          sym -= 257;
          if (sym >= 29) throw new Error("gzip: longitud inválida");
          var len = LBASE[sym] + bits(LEXT[sym]);
          var ds = decode(dist);
          if (ds >= 30) throw new Error("gzip: distancia inválida");
          var d = DBASE[ds] + bits(DEXT[ds]);
          if (d > outPos) throw new Error("gzip: distancia fuera de rango");
          ensure(len);
          var from = outPos - d;
          for (var k = 0; k < len; k++) out[outPos++] = out[from++];
        }
      }
    }

    var last;
    do {
      last = bits(1);
      var type = bits(2);
      if (type === 0) {
        bitBuf = 0; bitCnt = 0;
        var len = data[pos] | (data[pos + 1] << 8);
        pos += 4;
        ensure(len);
        out.set(data.subarray(pos, pos + len), outPos);
        outPos += len;
        pos += len;
      } else if (type === 1) {
        buildFixed();
        codes(fixedLit, fixedDist);
      } else if (type === 2) {
        var nlen = bits(5) + 257;
        var ndist = bits(5) + 1;
        var ncode = bits(4) + 4;
        var lengths = new Uint8Array(320);
        var i;
        for (i = 0; i < ncode; i++) lengths[ORDER[i]] = bits(3);
        var lencode = buildHuffman(lengths, 0, 19);
        lengths = new Uint8Array(320);
        i = 0;
        while (i < nlen + ndist) {
          var sym = decode(lencode);
          if (sym < 16) {
            lengths[i++] = sym;
          } else {
            var prev = 0, rep;
            if (sym === 16) {
              if (i === 0) throw new Error("gzip: repetición inválida");
              prev = lengths[i - 1];
              rep = 3 + bits(2);
            } else if (sym === 17) {
              rep = 3 + bits(3);
            } else {
              rep = 11 + bits(7);
            }
            while (rep--) lengths[i++] = prev;
          }
        }
        var lit = buildHuffman(lengths, 0, nlen);
        var dst = buildHuffman(lengths, nlen, ndist);
        codes(lit, dst);
      } else {
        throw new Error("gzip: bloque inválido");
      }
    } while (!last);

    return out.subarray(0, outPos);
  }

  function gunzip(data) {
    if (data.length < 18 || data[0] !== 0x1f || data[1] !== 0x8b || data[2] !== 8) {
      throw new Error("No es un archivo gzip");
    }
    var flags = data[3];
    var pos = 10;
    if (flags & 4) pos += 2 + (data[pos] | (data[pos + 1] << 8));
    if (flags & 8) { while (data[pos++] !== 0) { /* nombre */ } }
    if (flags & 16) { while (data[pos++] !== 0) { /* comentario */ } }
    if (flags & 2) pos += 2;
    var n = data.length;
    var isize = (data[n - 4] | (data[n - 3] << 8) | (data[n - 2] << 16) | (data[n - 1] << 24)) >>> 0;
    return inflate(data, pos, isize < 0x40000000 ? isize : 0);
  }

  window.Gunzip = { gunzip: gunzip };
})();
