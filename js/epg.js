/*
 * Port de EpgRepository.kt: descarga la guía XMLTV (.xml.gz), la descomprime,
 * la interpreta, la guarda 6 horas y la asocia a cada canal por nombre/alias.
 */
(function () {
  var CFG = window.TP_CONFIG;

  var CACHE_KEY = "tp_epg_v1";
  var CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  var KEEP_PAST_MS = 3 * 60 * 60 * 1000;
  var KEEP_FUTURE_MS = 36 * 60 * 60 * 1000;

  var memory = null;      // snapshot en memoria
  var loading = null;     // descarga en curso
  var nowNextCache = {};  // id de canal -> { now, next }

  /* ---------- Normalización y alias ---------- */
  function stripAccents(v) {
    var s = String(v || "");
    if (s.normalize) s = s.normalize("NFD");
    return s.replace(/[\u0300-\u036f]+/g, "");
  }

  function normalize(value) {
    var s = stripAccents(value)
      .toLowerCase()
      .replace(/&amp;/g, "and")
      .replace(/&/g, "and")
      .replace(/[._|:\/\\()\[\]{}-]+/g, " ")
      .replace(/\b(canal|latinoamerica|latino|cl)\b/g, " ")
      .replace(/\b(fhd|uhd|hd|sd|4k|1080p?|720p?|hevc|h265|h264)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (s.indexOf("cl ") === 0) s = s.substring(3).trim();
    return s;
  }

  function has(n, s) { return n.indexOf(s) !== -1; }
  function word(n, w) { return new RegExp("(^| )" + w + "( |$)").test(n); }

  function canonical(value) {
    var n = normalize(value);
    if (word(n, "chv") || has(n, "chilevision")) return "chilevision";
    if (word(n, "tvn") || has(n, "television nacional")) return "tvn";
    if (has(n, "24 horas")) return "24 horas";
    if (has(n, "canal 13") || word(n, "13")) return "canal 13";
    if (word(n, "mega")) return "mega";
    if (has(n, "la red")) return "la red";
    if (has(n, "cnn chile")) return "cnn chile";
    if (has(n, "zona latina")) return "zona latina";
    if (has(n, "via x")) return "via x";
    if (has(n, "tv chile")) return "tv chile";
    if (has(n, "espn 2")) return "espn 2";
    if (has(n, "espn 3")) return "espn 3";
    if (word(n, "espn")) return "espn";
    if (has(n, "tyc sports")) return "tyc sports";
    if (has(n, "goltv") || has(n, "gol tv")) return "goltv";
    if (has(n, "dsports motor")) return "dsports motor";
    if (has(n, "dsports 2")) return "dsports 2";
    if (has(n, "dsports +") || has(n, "dsports plus")) return "dsports +";
    if (word(n, "dsports")) return "dsports";
    return null;
  }

  function addAlias(aliases, value, channelId) {
    var normalized = normalize(value);
    if (normalized && !(normalized in aliases)) aliases[normalized] = channelId;
    var c = canonical(value);
    if (c && !(c in aliases)) aliases[c] = channelId;
  }

  function findEpgId(channel, snap) {
    var aliases = snap.aliases;
    var candidates = [];
    if (channel.epgChannelId) candidates.push(channel.epgChannelId);
    candidates.push(channel.name);

    for (var i = 0; i < candidates.length; i++) {
      var v = candidates[i];
      var direct = aliases[normalize(v)];
      if (direct) return direct;
      var c = canonical(v);
      if (c && aliases[c]) return aliases[c];
    }

    var target = normalize(channel.name);
    if (target.length < 3) return null;
    if (!snap._keys) snap._keys = Object.keys(aliases);
    var best = null, bestDiff = Infinity;
    for (var k = 0; k < snap._keys.length; k++) {
      var alias = snap._keys[k];
      if (alias.length < 3) continue;
      if (alias.indexOf(target) !== -1 || target.indexOf(alias) !== -1) {
        var diff = Math.abs(alias.length - target.length);
        if (diff < bestDiff) { bestDiff = diff; best = alias; }
      }
    }
    return best ? aliases[best] : null;
  }

  /* ---------- XMLTV ---------- */
  function decodeXml(s) {
    if (s.indexOf("<![CDATA[") !== -1) s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
    if (s.indexOf("&") === -1) return s;
    return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, function (m, e) {
      var l = e.toLowerCase();
      if (l === "lt") return "<";
      if (l === "gt") return ">";
      if (l === "quot") return '"';
      if (l === "apos") return "'";
      if (l === "amp") return "&";
      var code = l.charAt(1) === "x" ? parseInt(l.substring(2), 16) : parseInt(l.substring(1), 10);
      try { return String.fromCodePoint ? String.fromCodePoint(code) : String.fromCharCode(code); }
      catch (err) { return m; }
    });
  }

  function attr(tag, name) {
    var m = new RegExp("(?:^|\\s)" + name + "=(?:\"([^\"]*)\"|'([^']*)')").exec(tag);
    if (!m) return "";
    return decodeXml(m[1] !== undefined ? m[1] : m[2]);
  }

  function parseXmltvTime(raw) {
    if (!raw) return 0;
    var m = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(raw);
    if (!m) return 0;
    var ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
    if (m[7]) {
      var sign = m[7].charAt(0) === "-" ? -1 : 1;
      var offMin = parseInt(m[7].substring(1, 3), 10) * 60 + parseInt(m[7].substring(3, 5), 10);
      ms -= sign * offMin * 60000;
    }
    return ms;
  }

  function isTagStart(text, i, len) {
    var c = text.charAt(i + len);
    return c === " " || c === ">" || c === "\n" || c === "\r" || c === "\t" || c === "/";
  }

  function parseXmlTv(text, aliases, programs) {
    var now = Date.now();
    var minTime = now - KEEP_PAST_MS;
    var maxTime = now + KEEP_FUTURE_MS;
    var pos = 0, i, tagEnd, end;

    // Canales y sus nombres (alias)
    while ((i = text.indexOf("<channel", pos)) !== -1) {
      if (!isTagStart(text, i, 8)) { pos = i + 8; continue; }
      tagEnd = text.indexOf(">", i);
      end = text.indexOf("</channel>", tagEnd);
      if (tagEnd < 0 || end < 0) break;
      var id = attr(text.substring(i + 8, tagEnd), "id");
      if (id) {
        addAlias(aliases, id, id);
        var body = text.substring(tagEnd + 1, end);
        var p = 0, d;
        while ((d = body.indexOf("<display-name", p)) !== -1) {
          var dEnd = body.indexOf(">", d);
          var dClose = body.indexOf("</display-name>", dEnd);
          if (dEnd < 0 || dClose < 0) break;
          addAlias(aliases, decodeXml(body.substring(dEnd + 1, dClose)), id);
          p = dClose + 15;
        }
      }
      pos = end + 10;
    }

    // Programas
    pos = 0;
    while ((i = text.indexOf("<programme", pos)) !== -1) {
      if (!isTagStart(text, i, 10)) { pos = i + 10; continue; }
      tagEnd = text.indexOf(">", i);
      if (tagEnd < 0) break;
      end = text.indexOf("</programme>", tagEnd);
      if (end < 0) break;
      var tag = text.substring(i + 10, tagEnd);
      var channelId = attr(tag, "channel");
      var start = parseXmltvTime(attr(tag, "start"));
      var stop = parseXmltvTime(attr(tag, "stop"));
      var safeStop = stop > start ? stop : start + 60 * 60 * 1000;

      if (channelId && start >= minTime && start <= maxTime && safeStop >= minTime) {
        var pbody = text.substring(tagEnd + 1, end);
        var t = pbody.indexOf("<title");
        if (t !== -1) {
          var tEnd = pbody.indexOf(">", t);
          var tClose = pbody.indexOf("</title>", tEnd);
          if (tEnd >= 0 && tClose >= 0) {
            var title = decodeXml(pbody.substring(tEnd + 1, tClose)).trim();
            if (title) {
              (programs[channelId] || (programs[channelId] = [])).push(
                { title: title, startMs: start, stopMs: safeStop });
            }
          }
        }
      }
      pos = end + 12;
    }
  }

  function bytesToText(bytes) {
    if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(bytes);
    var out = "", CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    try { return decodeURIComponent(escape(out)); } catch (e) { return out; }
  }

  function fetchBytes(url) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.responseType = "arraybuffer";
      xhr.timeout = CFG.BULK_TIMEOUT_MS || 90000;
      xhr.onload = function () {
        if (xhr.status < 200 || xhr.status >= 300) { reject(new Error("HTTP " + xhr.status)); return; }
        resolve(new Uint8Array(xhr.response));
      };
      xhr.onerror = function () { reject(new Error("network")); };
      xhr.ontimeout = function () { reject(new Error("timeout")); };
      xhr.send();
    });
  }

  function downloadSnapshot() {
    var aliases = Object.create(null);
    var programs = Object.create(null);
    var urls = (CFG.EPG_URLS || []).slice();

    var chain = Promise.resolve();
    urls.forEach(function (url) {
      chain = chain.then(function () {
        return fetchBytes(url).then(function (bytes) {
          var raw = (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) ? window.Gunzip.gunzip(bytes) : bytes;
          parseXmlTv(bytesToText(raw), aliases, programs);
        }).catch(function () { /* esta fuente falló: se sigue con las demás */ });
      });
    });

    return chain.then(function () {
      Object.keys(programs).forEach(function (id) {
        programs[id].sort(function (a, b) { return a.startMs - b.startMs; });
      });
      return { aliases: aliases, programs: programs, savedAt: Date.now() };
    });
  }

  /* ---------- Caché local (6 horas) ---------- */
  function saveToStorage(snap) {
    try {
      var compact = {};
      Object.keys(snap.programs).forEach(function (id) {
        compact[id] = snap.programs[id].map(function (p) { return [p.title, p.startMs, p.stopMs]; });
      });
      localStorage.setItem(CACHE_KEY, JSON.stringify({ aliases: snap.aliases, programs: compact, savedAt: snap.savedAt }));
    } catch (e) { /* sin espacio: queda solo en memoria */ }
  }

  function loadFromStorage() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || !data.aliases || !data.programs) return null;
      var programs = {};
      Object.keys(data.programs).forEach(function (id) {
        programs[id] = data.programs[id].map(function (p) { return { title: p[0], startMs: p[1], stopMs: p[2] }; });
      });
      return { aliases: data.aliases, programs: programs, savedAt: data.savedAt || 0 };
    } catch (e) { return null; }
  }

  function hasPrograms(snap) { return snap && Object.keys(snap.programs).length > 0; }

  function getSnapshot() {
    if (loading) return loading;
    var cached = memory || loadFromStorage();
    if (cached && Date.now() - cached.savedAt < CACHE_MAX_AGE_MS) {
      memory = cached;
      return Promise.resolve(cached);
    }
    loading = downloadSnapshot().then(function (snap) {
      loading = null;
      if (hasPrograms(snap)) { memory = snap; saveToStorage(snap); return snap; }
      if (cached) memory = cached;
      return cached || null;
    }, function () {
      loading = null;
      return cached || null;
    });
    return loading;
  }

  /* ---------- Resolución ahora / siguiente ---------- */
  function resolve(channels, snap) {
    var now = Date.now();
    channels.forEach(function (ch) {
      var epgId = findEpgId(ch, snap);
      var schedule = epgId ? snap.programs[epgId] : null;
      if (!schedule || !schedule.length) return;

      var current = null, i;
      for (i = schedule.length - 1; i >= 0; i--) {
        if (schedule[i].startMs <= now && schedule[i].stopMs > now) { current = schedule[i]; break; }
      }
      var from = current ? current.stopMs : now;
      var next = null;
      for (i = 0; i < schedule.length; i++) { if (schedule[i].startMs >= from) { next = schedule[i]; break; } }
      if (!next) {
        for (i = 0; i < schedule.length; i++) { if (schedule[i].startMs > now) { next = schedule[i]; break; } }
      }
      if (current || next) nowNextCache[ch.id] = { now: current, next: next };
      else delete nowNextCache[ch.id];
    });
  }

  /* ---------- API pública ---------- */
  function loadCachedNowNext(channels) {
    var snap = memory || loadFromStorage();
    if (snap) { memory = snap; resolve(channels, snap); }
    return Promise.resolve(nowNextCache);
  }

  function loadNowNext(channels) {
    return getSnapshot().then(function (snap) {
      if (snap) resolve(channels, snap);
      return nowNextCache;
    });
  }

  function loadSchedule(channel) {
    return getSnapshot().then(function (snap) {
      if (!snap) return [];
      var epgId = findEpgId(channel, snap);
      if (!epgId) return [];
      var cutoff = Date.now() - 60 * 60 * 1000;
      return (snap.programs[epgId] || [])
        .filter(function (p) { return p.stopMs > cutoff; })
        .sort(function (a, b) { return a.startMs - b.startMs; });
    });
  }

  window.Epg = {
    cache: nowNextCache,
    loadCachedNowNext: loadCachedNowNext,
    loadNowNext: loadNowNext,
    loadSchedule: loadSchedule,
    _internals: { normalize: normalize, canonical: canonical, parseXmlTv: parseXmlTv, parseXmltvTime: parseXmltvTime }
  };
})();
