/*
 * Caché de logos: cada logo de la lista M3U/Xtream se descarga UNA sola vez y se guarda
 * en IndexedDB (como archivo). Las siguientes veces sale del almacenamiento de la TV.
 *
 *   LogoCache.resolve(url) -> Promise<string|null>
 *       texto listo para <img src> (blob local), o null si no se pudo guardar
 *       (por ejemplo, el servidor del logo no permite descargas desde apps web:
 *        en ese caso la app usa la dirección directa y el navegador hace su propia caché).
 *   LogoCache.prefetch(urls) descarga en segundo plano TODOS los logos que aún no estén guardados
 *                           (en la primera carga de la lista) y, UNA VEZ AL DÍA, pregunta al servidor
 *                           si cada logo cambió: solo vuelve a bajar los que cambiaron.
 *   LogoCache.prune(urls)  borra los logos que ya no están en la lista actual
 *   LogoCache.clear()      borra todo
 */
(function () {
  var DB_NAME = "tp_logos", STORE = "logos";
  var FAIL_RETRY_MS = 24 * 60 * 60 * 1000;   // un logo que falló se reintenta después de 24 h
  var CHECK_EVERY_MS = 24 * 60 * 60 * 1000;  // revisión de cambios: una vez al día
  var MAX_PARALLEL = 4;

  var dbPromise = null;
  var mem = {};        // url -> blob ya en memoria
  var srcCache = {};   // url -> blob: URL ya creada (se reutiliza)
  var pending = {};    // url -> Promise en curso (evita descargar dos veces lo mismo)
  var refreshing = {}; // url -> true mientras se revisa si cambió
  var queue = [], running = 0;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      try {
        if (!window.indexedDB) { resolve(null); return; }
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "url" });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
    return dbPromise;
  }

  function idbGet(db, url) {
    return new Promise(function (resolve) {
      try {
        var r = db.transaction(STORE, "readonly").objectStore(STORE).get(url);
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }

  function idbPut(db, rec) {
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(rec);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
        tx.onabort = function () { resolve(false); };
      } catch (e) { resolve(false); }
    });
  }

  /* Descarga un logo. Si se pasa "prev" (copia guardada) pregunta si cambió:
     el servidor responde 304 y no se descarga nada.
     Resultado: { blob, etag, lm } nuevo, { same: true } sin cambios, o null si falló. */
  function download(url, prev) {
    return new Promise(function (resolve) {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.responseType = "blob";
        xhr.timeout = 15000;
        if (prev) {
          try {
            if (prev.etag) xhr.setRequestHeader("If-None-Match", prev.etag);
            if (prev.lm) xhr.setRequestHeader("If-Modified-Since", prev.lm);
          } catch (e) {}
        }
        xhr.onload = function () {
          if (xhr.status === 304) { resolve({ same: true }); return; }
          var b = xhr.response;
          var ok = xhr.status >= 200 && xhr.status < 300 && b && b.size > 0 && (!b.type || /^image\//i.test(b.type));
          if (!ok) { resolve(null); return; }
          var etag = null, lm = null;
          try { etag = xhr.getResponseHeader("ETag"); lm = xhr.getResponseHeader("Last-Modified"); } catch (e) {}
          resolve({ blob: b, etag: etag, lm: lm });
        };
        xhr.onerror = function () { resolve(null); };   // incluye bloqueo por CORS
        xhr.ontimeout = function () { resolve(null); };
        xhr.send();
      } catch (e) { resolve(null); }
    });
  }

  // Compara dos imágenes byte a byte (para servidores que no responden 304).
  function readBytes(blob) {
    return new Promise(function (res) {
      try {
        var r = new FileReader();
        r.onload = function () { res(new Uint8Array(r.result)); };
        r.onerror = function () { res(null); };
        r.readAsArrayBuffer(blob);
      } catch (e) { res(null); }
    });
  }
  function sameBlob(a, b) {
    if (!a || !b || a.size !== b.size) return Promise.resolve(false);
    return Promise.all([readBytes(a), readBytes(b)]).then(function (x) {
      if (!x[0] || !x[1]) return false;
      for (var i = 0; i < x[0].length; i++) if (x[0][i] !== x[1][i]) return false;
      return true;
    });
  }

  function pump() {
    while (running < MAX_PARALLEL && queue.length) {
      var job = queue.shift();
      running++;
      (function (j) {
        download(j.url, j.prev).then(function (r) { running--; j.done(r); pump(); });
      })(job);
    }
  }
  function queueDownload(url, prev) {
    return new Promise(function (resolve) { queue.push({ url: url, prev: prev, done: resolve }); pump(); });
  }

  function toSrc(blob, url) {
    if (url && srcCache[url]) return srcCache[url];
    try {
      var src = URL.createObjectURL(blob);
      if (url) srcCache[url] = src;
      return src;
    } catch (e) { return null; }
  }

  function resolve(url) {
    if (!url) return Promise.resolve(null);
    if (mem[url]) return Promise.resolve(toSrc(mem[url], url) || null);
    if (pending[url]) return pending[url];

    var p = openDb().then(function (db) {
      var stored = db ? idbGet(db, url) : Promise.resolve(null);
      return stored.then(function (rec) {
        if (rec && rec.blob) { mem[url] = rec.blob; return toSrc(rec.blob, url); }
        if (rec && rec.fail && Date.now() - rec.at < FAIL_RETRY_MS) return null;
        return queueDownload(url).then(function (r) {
          if (r && r.blob) {
            mem[url] = r.blob;
            var now = Date.now();
            if (db) idbPut(db, { url: url, blob: r.blob, at: now, checked: now, etag: r.etag, lm: r.lm });
            return toSrc(r.blob, url);
          }
          if (db) idbPut(db, { url: url, fail: true, at: Date.now() });
          return null;
        });
      });
    }).then(function (src) { delete pending[url]; return src; },
            function () { delete pending[url]; return null; });
    pending[url] = p;
    return p;
  }

  function storedRecords(db) {
    return new Promise(function (res) {
      var recs = {};
      try {
        var cur = db.transaction(STORE, "readonly").objectStore(STORE).openCursor();
        cur.onsuccess = function () {
          var c = cur.result;
          if (!c) { res(recs); return; }
          recs[c.value.url] = c.value;
          c.continue();
        };
        cur.onerror = function () { res(recs); };
      } catch (e) { res(recs); }
    });
  }

  // Revisión diaria de un logo ya guardado: solo se reemplaza si cambió.
  function refresh(db, rec) {
    var url = rec.url;
    if (refreshing[url]) return;
    refreshing[url] = true;
    queueDownload(url, rec).then(function (r) {
      var now = Date.now();
      if (!r) {                                   // sin conexión o error: se reintenta mañana
        rec.checked = now;
        return idbPut(db, rec);
      }
      if (r.same) { rec.checked = now; return idbPut(db, rec); }
      return sameBlob(rec.blob, r.blob).then(function (same) {
        if (same) {
          rec.checked = now; rec.etag = r.etag || rec.etag; rec.lm = r.lm || rec.lm;
          return idbPut(db, rec);
        }
        // El logo cambió: se guarda el nuevo y se muestra la próxima vez que se dibuje.
        mem[url] = r.blob;
        if (srcCache[url]) { try { URL.revokeObjectURL(srcCache[url]); } catch (e) {} delete srcCache[url]; }
        return idbPut(db, { url: url, blob: r.blob, at: now, checked: now, etag: r.etag, lm: r.lm });
      });
    }).then(function () { delete refreshing[url]; }, function () { delete refreshing[url]; });
  }

  // Descarga una sola vez los logos que faltan y, una vez al día, revisa si los guardados cambiaron.
  function prefetch(urls) {
    var want = {}, list = [];
    (urls || []).forEach(function (u) {
      if (u && /^https?:/i.test(u) && !want[u]) { want[u] = true; list.push(u); }
    });
    if (!list.length) return Promise.resolve(0);
    return openDb().then(function (db) {
      if (!db) return 0;
      return storedRecords(db).then(function (recs) {
        var now = Date.now();
        var missing = 0;
        list.forEach(function (u) {
          var rec = recs[u];
          if (rec && rec.blob) {
            if (now - (rec.checked || rec.at || 0) >= CHECK_EVERY_MS) refresh(db, rec);
          } else if (rec && rec.fail && now - rec.at < FAIL_RETRY_MS) {
            /* falló hace poco: se reintenta mañana */
          } else if (!mem[u] && !pending[u]) {
            missing++;
            resolve(u);                               // usa la misma cola (4 a la vez)
          }
        });
        return missing;
      });
    });
  }

  function prune(urls) {
    var keep = {};
    (urls || []).forEach(function (u) { if (u) keep[u] = true; });
    if (!Object.keys(keep).length) return;
    openDb().then(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction(STORE, "readwrite");
        var store = tx.objectStore(STORE);
        var cur = store.openCursor();
        cur.onsuccess = function () {
          var c = cur.result;
          if (!c) return;
          if (!keep[c.value.url]) {
            delete mem[c.value.url];
            if (srcCache[c.value.url]) { try { URL.revokeObjectURL(srcCache[c.value.url]); } catch (e) {} delete srcCache[c.value.url]; }
            c.delete();
          }
          c.continue();
        };
      } catch (e) { /* sin permiso: se ignora */ }
    });
  }

  function clear() {
    mem = {}; queue.length = 0;
    Object.keys(srcCache).forEach(function (k) { try { URL.revokeObjectURL(srcCache[k]); } catch (e) {} });
    srcCache = {};
    openDb().then(function (db) {
      if (!db) return;
      try { db.transaction(STORE, "readwrite").objectStore(STORE).clear(); } catch (e) {}
    });
  }

  window.LogoCache = { resolve: resolve, prefetch: prefetch, prune: prune, clear: clear };
})();
