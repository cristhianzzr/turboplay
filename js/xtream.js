/*
 * Cliente Xtream Codes + lista M3U.
 *   - Con usuario y contraseña: Xtream (player_api.php), con respaldo M3U (get.php).
 *   - Sin usuario ni contraseña: la URL escrita es una lista M3U directa.
 * Estilo ES5 + Promise para compatibilidad con TVs antiguas (Tizen 2.4 / 3.0).
 *
 * "session" = { server, username, password }
 */
(function () {
  var CFG = window.TP_CONFIG;

  function InvalidCredentialsError(message) {
    this.name = "InvalidCredentialsError";
    this.message = message || "La sesión ya no es válida.";
  }
  InvalidCredentialsError.prototype = Object.create(Error.prototype);

  function isM3uMode(s) { return !s.username && !s.password; }
  function base(s) { return String(s.server || "").replace(/\/+$/, ""); }

  /* Limpia lo que el usuario escribió: agrega http:// si falta y, en modo Xtream, deja solo servidor:puerto. */
  function normalizeServer(raw, m3uMode) {
    var s = String(raw || "").replace(/\s+/g, "");
    if (!s) return "";
    if (!/^[a-z][a-z0-9+.\-]*:\/\//i.test(s)) s = "http://" + s;
    if (m3uMode) return s;
    var m = /^(https?:\/\/[^\/?#]+)/i.exec(s);
    return m ? m[1] : s;
  }

  function playerApiUrl(s, action) {
    var url = base(s) + "/player_api.php?username=" + encodeURIComponent(s.username) +
      "&password=" + encodeURIComponent(s.password);
    if (action) url += "&action=" + encodeURIComponent(action);
    return url;
  }

  function m3uUrl(s) {
    if (isM3uMode(s)) return s.server;
    return base(s) + "/get.php?username=" + encodeURIComponent(s.username) +
      "&password=" + encodeURIComponent(s.password) + "&type=m3u_plus&output=mpegts";
  }

  /* ---------- HTTP ---------- */
  function getText(url, timeoutMs, maxLines) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var done = false;
      xhr.open("GET", url, true);
      xhr.timeout = timeoutMs || CFG.REQUEST_TIMEOUT_MS;
      function fail(msg) {
        if (done) return;
        done = true;
        var e = new Error(msg);
        e.status = xhr.status;
        reject(e);
      }
      if (maxLines) {
        // Solo necesitamos las primeras líneas (comprobar la cabecera M3U).
        xhr.onprogress = function () {
          if (done) return;
          var t = xhr.responseText || "";
          var lines = 0, idx = -1;
          while ((idx = t.indexOf("\n", idx + 1)) !== -1) { if (++lines >= maxLines) break; }
          if (lines >= maxLines) { done = true; xhr.abort(); resolve(t); }
        };
      }
      xhr.onload = function () {
        if (done) return;
        if (xhr.status < 200 || xhr.status >= 300) { fail("HTTP " + xhr.status); return; }
        done = true;
        resolve(xhr.responseText);
      };
      xhr.onerror = function () { fail("network"); };
      xhr.ontimeout = function () { fail("timeout"); };
      xhr.send();
    });
  }

  /* ---------- player_api.php ---------- */
  // true = credenciales válidas, false = inválidas, null = el servidor no respondió como Xtream.
  function apiAuth(s) {
    return getText(playerApiUrl(s)).then(function (text) {
      var t = (text || "").replace(/^\s+/, "");
      if (!t || (t.charAt(0) !== "{" && t.charAt(0) !== "[")) return null;
      var root;
      try { root = JSON.parse(t); } catch (e) { return null; }
      var info = root && !Array.isArray(root) && root.user_info;
      if (!info || typeof info !== "object") return null;
      var auth = info.auth;
      if (auth === undefined || auth === null) return null;
      var v = String(auth).toLowerCase();
      return (v === "1" || v === "true");
    }, function () { return null; });
  }

  function getJsonArray(s, action) {
    return getText(playerApiUrl(s, action)).then(function (text) {
      if (!text) return null;
      var root = JSON.parse(text);
      return Array.isArray(root) ? root : null;
    });
  }

  function str(v) { return (v === undefined || v === null) ? null : String(v); }

  function liveStreamUrl(s, id, extension) {
    var ext;
    if (CFG.PREFERRED_EXT === "ts" || CFG.PREFERRED_EXT === "m3u8") {
      ext = CFG.PREFERRED_EXT;
    } else {
      var e = (extension || "").toLowerCase();
      ext = (e === "ts" || e === "m3u8") ? e : "ts";
    }
    return base(s) + "/live/" + encodeURIComponent(s.username) + "/" + encodeURIComponent(s.password) +
      "/" + id + "." + ext;
  }

  function loadViaApi(s) {
    return Promise.all([
      getJsonArray(s, "get_live_categories"),
      getJsonArray(s, "get_live_streams")
    ]).then(function (res) {
      var categories = (res[0] || []).filter(function (c) {
        return c && typeof c === "object" && c.category_id !== undefined && c.category_id !== null;
      }).map(function (c) {
        return { id: String(c.category_id), name: str(c.category_name) || "Categoría" };
      });

      var channels = [];
      (res[1] || []).forEach(function (it) {
        if (!it || typeof it !== "object") return;
        var id = parseInt(it.stream_id, 10);
        if (isNaN(id)) return;
        channels.push({
          id: id,
          name: str(it.name) || "Canal",
          categoryId: str(it.category_id),
          logo: it.stream_icon ? String(it.stream_icon) : null,
          streamUrl: liveStreamUrl(s, id, str(it.container_extension)),
          epgChannelId: it.epg_channel_id ? String(it.epg_channel_id) : null
        });
      });
      return channels.length ? { categories: categories, channels: channels, source: "api" } : null;
    }).catch(function () { return null; });   // seguimos al respaldo M3U
  }

  /* ---------- Lista M3U ---------- */
  function javaHash(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = ((Math.imul ? Math.imul(31, h) : (31 * h)) + str.charCodeAt(i)) | 0;
    return h;
  }

  function parseM3u(text) {
    var channels = [], categories = [], seen = {};
    var pending = null;
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (/^#EXTINF/i.test(line)) { pending = line; continue; }
      if (line && line.charAt(0) !== "#" && pending) {
        var attrs = {}, m, re = /([\w-]+)="([^"]*)"/g;
        while ((m = re.exec(pending)) !== null) attrs[m[1]] = m[2];
        var group = (attrs["group-title"] || "").trim() || "Otros";
        var catId = "m3u:" + javaHash(group.toLowerCase());
        if (!seen[catId]) { seen[catId] = true; categories.push({ id: catId, name: group }); }
        var comma = pending.lastIndexOf(",");
        var name = (comma >= 0 ? pending.substring(comma + 1) : "Canal").trim() || "Canal";
        channels.push({
          id: javaHash(line) & 0x7fffffff,
          name: name,
          categoryId: catId,
          logo: attrs["tvg-logo"] || null,
          streamUrl: line,
          epgChannelId: attrs["tvg-id"] || null
        });
        pending = null;
      }
    }
    return { categories: categories, channels: channels, source: "m3u" };
  }

  function checkM3uHeader(s) {
    return getText(m3uUrl(s), CFG.REQUEST_TIMEOUT_MS, 30).then(function (text) {
      var head = text.split(/\r?\n/).slice(0, 30);
      var ok = head.some(function (l) { return l.indexOf("#EXTM3U") === 0 || l.indexOf("#EXTINF") === 0; });
      return ok ? { success: true, message: "Conexión correcta" }
                : { success: false, message: "La lista no tiene un formato compatible." };
    }, function (e) {
      if (e && e.status) return { success: false, message: "No pudimos abrir la lista (" + e.status + ")." };
      return { success: false, message: "No se pudo conectar con el servidor. Revisa internet y la dirección." };
    });
  }

  /* ---------- API pública ---------- */
  function authenticate(s) {
    if (isM3uMode(s)) return checkM3uHeader(s);
    return apiAuth(s).then(function (api) {
      if (api === true) return { success: true, message: "Conexión correcta" };
      if (api === false) return { success: false, message: "Usuario o contraseña incorrectos." };
      return checkM3uHeader(s);   // player_api.php no respondió: probamos get.php
    });
  }

  function loadChannels(s) {
    function viaM3u() {
      return getText(m3uUrl(s), CFG.BULK_TIMEOUT_MS).then(function (text) {
        var parsed = parseM3u(text);
        if (!parsed.channels.length) throw new Error("La lista no contiene canales en vivo.");
        return parsed;
      }, function (e) {
        if (e && (e.status === 401 || e.status === 403)) throw new InvalidCredentialsError();
        throw e;
      });
    }
    if (isM3uMode(s)) return viaM3u();
    return apiAuth(s).then(function (auth) {
      if (auth === false) throw new InvalidCredentialsError();
      var viaApi = (auth === true) ? loadViaApi(s) : Promise.resolve(null);
      return viaApi.then(function (bundle) { return bundle || viaM3u(); });
    });
  }

  window.Xtream = {
    InvalidCredentialsError: InvalidCredentialsError,
    normalizeServer: normalizeServer,
    authenticate: authenticate,
    loadChannels: loadChannels
  };
})();
