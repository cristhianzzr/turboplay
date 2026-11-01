/*
 * Turbo Play para Samsung Tizen - lógica principal (port de la versión LG webOS).
 * Equivale a LoginActivity + ChannelsActivity + GuideActivity + PlayerActivity.
 */
(function () {
  "use strict";

  var G = window.ChannelGroups;
  var X = window.Xtream;

  /* ====================================================================
   *  Utilidades
   * ==================================================================== */
  function $(id) { return document.getElementById(id); }

  /* ---------- Logos de canal ----------
   * Vienen de la lista M3U (tvg-logo) o del servidor Xtream (stream_icon).
   * Si el canal no trae logo o no carga, el recuadro se oculta y queda solo el nombre. */
  function fillLogoBox(box, ch) {
    box.innerHTML = "";
    box.style.display = "none";
    if (!ch.logo || !/^https?:/i.test(ch.logo)) return;
    var img = document.createElement("img");
    img.alt = "";
    img.onload = function () { box.style.display = "flex"; };
    img.onerror = function () { img.onerror = null; box.style.display = "none"; };
    box.appendChild(img);
    // Primero la copia guardada (se descarga una sola vez); si no se pudo guardar, la dirección directa.
    window.LogoCache.resolve(ch.logo).then(function (src) { img.src = src || ch.logo; });
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function formatTime(ms) {
    var d = new Date(ms);
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  /* ====================================================================
   *  Almacenamiento (credenciales y lista de canales)
   * ==================================================================== */
  /* La sesión se guarda en tres lugares a la vez (localStorage, cookie e IndexedDB) porque
     al desenchufar la TV sin apagarla, la TV puede perder lo último escrito en uno de ellos. */
  var AuthDB = {
    open: function (cb) {
      try {
        var rq = indexedDB.open("tp_auth", 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore("kv"); };
        rq.onsuccess = function () { cb(rq.result); };
        rq.onerror = function () { cb(null); };
      } catch (e) { cb(null); }
    },
    set: function (obj) {
      AuthDB.open(function (db) {
        if (!db) return;
        try { db.transaction("kv", "readwrite").objectStore("kv").put(obj, "session"); } catch (e) {}
      });
    },
    get: function (cb) {
      AuthDB.open(function (db) {
        if (!db) { cb(null); return; }
        try {
          var r = db.transaction("kv", "readonly").objectStore("kv").get("session");
          r.onsuccess = function () { cb(r.result || null); };
          r.onerror = function () { cb(null); };
        } catch (e) { cb(null); }
      });
    },
    clear: function () {
      AuthDB.open(function (db) {
        if (!db) return;
        try { db.transaction("kv", "readwrite").objectStore("kv").delete("session"); } catch (e) {}
      });
    }
  };

  var Store = {
    load: function () {
      try {
        var server = localStorage.getItem("tp_server");
        if (server) {
          return {
            server: server,
            username: localStorage.getItem("tp_user") || "",
            password: localStorage.getItem("tp_pass") || ""
          };
        }
      } catch (e) {}
      try {
        var m = /(?:^|;\s*)tp_session=([^;]*)/.exec(document.cookie || "");
        if (m) {
          var c = JSON.parse(decodeURIComponent(m[1]));
          if (c && c.server) {
            Store.save(c.server, c.username || "", c.password || "");
            return { server: c.server, username: c.username || "", password: c.password || "" };
          }
        }
      } catch (e) {}
      return null;
    },
    // Si localStorage y cookie están vacíos, intenta recuperar la sesión desde IndexedDB.
    restore: function (cb) {
      var c = Store.load();
      if (c) { cb(c); return; }
      AuthDB.get(function (o) {
        if (o && o.server) {
          Store.save(o.server, o.username || "", o.password || "");
          cb({ server: o.server, username: o.username || "", password: o.password || "" });
        } else cb(null);
      });
    },
    save: function (server, u, p) {
      try {
        localStorage.setItem("tp_server", server);
        localStorage.setItem("tp_user", u);
        localStorage.setItem("tp_pass", p);
      } catch (e) {}
      try {
        var exp = new Date(Date.now() + 3650 * 86400000).toUTCString();
        document.cookie = "tp_session=" + encodeURIComponent(JSON.stringify({ server: server, username: u, password: p })) +
          "; expires=" + exp + "; path=/";
      } catch (e) {}
      AuthDB.set({ server: server, username: u, password: p });
    },
    clear: function () {
      try {
        localStorage.removeItem("tp_server");
        localStorage.removeItem("tp_user");
        localStorage.removeItem("tp_pass");
      } catch (e) {}
      try { document.cookie = "tp_session=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/"; } catch (e) {}
      AuthDB.clear();
    },
    // Reescribe la sesión guardada para empujar el guardado a disco.
    refresh: function () {
      var c = Store.load();
      if (c) Store.save(c.server, c.username, c.password);
    }
  };
  // Con servidor fijo, la sesión guardada siempre usa la dirección actual de config.js
  // (si cambias el servidor, las TVs siguen conectadas con el mismo usuario).
  (function () {
    var fixed = (window.TP_CONFIG.FIXED_SERVER || "").trim();
    if (!fixed) return;
    var load = Store.load;
    Store.load = function () {
      var c = load();
      if (c) c.server = X.normalizeServer(fixed, false);
      return c;
    };
  })();
  setInterval(function () { Store.refresh(); }, 30000);
  window.addEventListener("pagehide", function () { Store.refresh(); });

  var Cache = {
    load: function () {
      try {
        var raw = localStorage.getItem("tp_cache_v3");
        if (!raw) return null;
        var data = JSON.parse(raw);
        return (data && data.channels && data.channels.length) ? data : null;
      } catch (e) { return null; }
    },
    save: function (bundle) {
      try { localStorage.setItem("tp_cache_v3", JSON.stringify(bundle)); } catch (e) { /* cuota llena: se omite */ }
    },
    clear: function () {
      try { localStorage.removeItem("tp_cache_v3"); } catch (e) {}
    }
  };

  /* ====================================================================
   *  Pantallas
   * ==================================================================== */
  var screens = {
    login: $("screen-login"),
    channels: $("screen-channels"),
    guide: $("screen-guide"),
    player: $("screen-player")
  };
  var current = "login";
  var modalOpen = false;

  function show(name) {
    current = name;
    Object.keys(screens).forEach(function (k) {
      screens[k].classList.toggle("hidden", k !== name);
    });
    // Con AVPlay el video se dibuja DEBAJO de la página: el fondo debe quedar transparente.
    document.documentElement.classList.toggle("player-on", name === "player");
  }

  function exitApp() {
    try { window.TvPlayer.stop(); } catch (e) {}
    try {
      if (window.tizen && tizen.application) { tizen.application.getCurrentApplication().exit(); return; }
    } catch (e) { /* ignorar */ }
    try { window.close(); } catch (e) { /* ignorar */ }
  }

  /* Teclas del control Samsung que hay que pedir explícitamente (las flechas, OK y BACK vienen siempre). */
  (function registerTvKeys() {
    try {
      if (!window.tizen || !tizen.tvinputdevice) return;
      ["ChannelUp", "ChannelDown", "Info", "Guide"].forEach(function (name) {
        try { tizen.tvinputdevice.registerKey(name); } catch (e) {}
      });
    } catch (e) {}
  })();

  /* ====================================================================
   *  Navegación espacial con el control remoto
   * ==================================================================== */
  function visibleFocusables() {
    var root = modalOpen ? $("confirmLogout") : screens[current];
    var nodes = root.querySelectorAll(".focusable");
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.disabled || el.offsetParent === null) continue;
      out.push(el);
    }
    return out;
  }

  function scrollContainerOf(el) {
    var node = el.parentNode;
    while (node && node !== document.body) {
      if (node.classList && (node.classList.contains("channel-grid") || node.classList.contains("guide-list"))) return node;
      node = node.parentNode;
    }
    return null;
  }

  function ensureVisible(el) {
    var box = scrollContainerOf(el);
    if (!box) return;
    var c = box.getBoundingClientRect();
    var r = el.getBoundingClientRect();
    var margin = 12;
    if (r.top < c.top + margin) box.scrollTop -= (c.top + margin - r.top);
    else if (r.bottom > c.bottom - margin) box.scrollTop += (r.bottom - (c.bottom - margin));
  }

  function focusEl(el) {
    el.focus();
    ensureVisible(el);
  }

  function move(dir) {
    if (!modalOpen && current === "channels" && dir === "down") maybeAppendCards(document.activeElement);

    var list = visibleFocusables();
    var cur = document.activeElement;
    if (!cur || list.indexOf(cur) < 0) {
      if (list.length) focusEl(list[0]);
      return;
    }
    var r = cur.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var best = null, bestScore = Infinity;

    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el === cur) continue;
      var b = el.getBoundingClientRect();
      var dx = (b.left + b.width / 2) - cx;
      var dy = (b.top + b.height / 2) - cy;
      var primary, secondary;
      if (dir === "left")  { if (dx > -4) continue; primary = -dx; secondary = Math.abs(dy); }
      if (dir === "right") { if (dx < 4)  continue; primary = dx;  secondary = Math.abs(dy); }
      if (dir === "up")    { if (dy > -4) continue; primary = -dy; secondary = Math.abs(dx); }
      if (dir === "down")  { if (dy < 4)  continue; primary = dy;  secondary = Math.abs(dx); }
      var score = primary + secondary * 2;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) focusEl(best);
  }

  /* ====================================================================
   *  LOGIN
   * ==================================================================== */
  var loginBtn = $("loginButton");
  var loginStatus = $("loginStatus");

  function setLoginStatus(text, color) {
    loginStatus.textContent = text;
    loginStatus.style.color = color || "";
  }

  var FIXED_SERVER = (window.TP_CONFIG.FIXED_SERVER || "").trim();

  // Con servidor fijo: se oculta el campo de dirección y la nota de M3U.
  if (FIXED_SERVER) {
    $("serverInput").classList.add("hidden");
    var note = document.querySelector(".login-note");
    if (note) note.classList.add("hidden");
  }

  function firstLoginField() { return FIXED_SERVER ? $("usernameInput") : $("serverInput"); }

  loginBtn.addEventListener("click", function () {
    var rawServer = FIXED_SERVER || $("serverInput").value;
    var user = $("usernameInput").value.trim();
    var pass = $("passwordInput").value;
    var ERR = "#FF7A7A";

    if (FIXED_SERVER && (!user || !pass)) {
      setLoginStatus("Escribe tu usuario y contraseña.", ERR);
      (user ? $("passwordInput") : $("usernameInput")).focus();
      return;
    }

    if (!rawServer.trim()) {
      setLoginStatus("Escribe la URL del servidor.", ERR);
      $("serverInput").focus();
      return;
    }
    if ((user && !pass) || (!user && pass)) {
      setLoginStatus("Escribe usuario y contraseña, o deja ambos vacíos para una lista M3U.", ERR);
      return;
    }
    var m3u = !user && !pass;
    var server = X.normalizeServer(rawServer, m3u);
    if (!/^https?:\/\//i.test(server)) {
      setLoginStatus("La URL debe empezar con http:// o https://", ERR);
      $("serverInput").focus();
      return;
    }

    loginBtn.disabled = true;
    $("loginProgress").classList.remove("hidden");
    setLoginStatus("Conectando…", "#C9D6FF");

    X.authenticate({ server: server, username: user, password: pass }).then(function (result) {
      $("loginProgress").classList.add("hidden");
      loginBtn.disabled = false;
      if (result.success) {
        Cache.clear();                    // lista y guía de la sesión anterior ya no sirven
        Store.save(server, user, pass);
        openChannels();
      } else {
        setLoginStatus(result.message, ERR);
        (m3u ? firstLoginField() : $("passwordInput")).focus();
      }
    });
  });

  function openLogin() {
    show("login");
    $("passwordInput").value = "";
    setLoginStatus("");
    firstLoginField().focus();
  }

  /* ====================================================================
   *  CANALES
   * ==================================================================== */
  var CATEGORIES = [
    { id: G.CHILE, name: "Canales chilenos" },
    { id: G.SPORTS, name: "Deportes" },
    { id: G.REMAINING, name: "Todos los canales" }
  ];
  var CHUNK = 50;

  var allChannels = [];
  var selectedGroup = G.CHILE;
  var filtered = [];
  var rendered = 0;
  var cardById = {};
  var epgStarted = false;
  var epgPaintTimer = null;
  var lastFocusedChannelId = null;

  var grid = $("channelGrid");
  var statusText = $("statusText");

  function buildCategoryChips() {
    var nav = $("categoryList");
    nav.innerHTML = "";
    CATEGORIES.forEach(function (cat) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip focusable";
      b.setAttribute("data-cat", cat.id);
      b.textContent = cat.name;
      b.addEventListener("click", function () {
        selectedGroup = cat.id;
        paintChips();
        filterChannels();
      });
      nav.appendChild(b);
    });
    paintChips();
  }

  function paintChips() {
    var chips = $("categoryList").children;
    for (var i = 0; i < chips.length; i++) {
      chips[i].classList.toggle("selected", chips[i].getAttribute("data-cat") === selectedGroup);
    }
  }

  // kind: "ok" = verde (conectado), "error" = rojo (sin conexión), "info" = blanco (cargando)
  function setStatus(text, kind) {
    statusText.textContent = text;
    statusText.style.color = kind === "ok" ? "#46E08A" : (kind === "error" ? "#FF7A7A" : "#FFFFFF");
  }

  function render(bundle, status, kind) {
    var names = {};
    bundle.categories.forEach(function (c) { names[c.id] = c.name; });
    var logoUrls = bundle.channels.map(function (c) { return c.logo; });
    window.LogoCache.prune(logoUrls);
    // Primera vez: baja todos los logos en segundo plano. Las siguientes, ya están guardados y no baja nada.
    setTimeout(function () { window.LogoCache.prefetch(logoUrls); }, 2500);
    allChannels = bundle.channels.map(function (ch) {
      var cat = ch.categoryId != null ? names[ch.categoryId] : null;
      ch.group = G.classify(ch, cat);
      ch.sortKey = G.sortKey(ch.name);
      return ch;
    });
    setStatus(status, kind);
    $("loadingPanel").classList.add("hidden");
    filterChannels();
  }

  function filterChannels() {
    filtered = allChannels.filter(function (ch) { return ch.group === selectedGroup; })
      .sort(function (a, b) { return a.sortKey < b.sortKey ? -1 : (a.sortKey > b.sortKey ? 1 : 0); });

    grid.innerHTML = "";
    cardById = {};
    rendered = 0;
    appendCards(CHUNK);
    grid.scrollTop = 0;

    $("emptyText").classList.toggle("hidden", filtered.length > 0);
    $("channelCountText").textContent = "TV EN VIVO • " + filtered.length + " canales";
  }

  function appendCards(n) {
    var end = Math.min(filtered.length, rendered + n);
    var frag = document.createDocumentFragment();
    for (var i = rendered; i < end; i++) frag.appendChild(makeCard(filtered[i]));
    grid.appendChild(frag);
    rendered = end;
    paintEpg();
  }

  function maybeAppendCards(cur) {
    if (!cur || !cur.classList || !cur.classList.contains("card")) return;
    if (rendered >= filtered.length) return;
    var idx = Array.prototype.indexOf.call(grid.children, cur);
    if (idx >= rendered - 12) appendCards(CHUNK);
  }

  function makeCard(ch) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "card focusable";
    b.setAttribute("data-id", ch.id);

    var box = document.createElement("div");
    box.className = "logo-box";
    fillLogoBox(box, ch);

    var name = document.createElement("div");
    name.className = "card-name";
    name.textContent = ch.name;

    var epg = document.createElement("div");
    epg.className = "card-epg hidden";

    b.appendChild(box);
    b.appendChild(name);
    b.appendChild(epg);
    b.addEventListener("click", function () { openPlayer(ch); });
    b.addEventListener("focus", function () { lastFocusedChannelId = ch.id; });
    cardById[ch.id] = { el: b, epg: epg };
    return b;
  }

  function paintEpg() {
    var map = window.Epg.cache;
    Object.keys(cardById).forEach(function (id) {
      var entry = cardById[id];
      var info = map[id];
      if (info && info.now) {
        entry.epg.textContent = formatTime(info.now.startMs) + "  " + info.now.title;
        entry.epg.classList.remove("hidden");
      } else {
        entry.epg.classList.add("hidden");
      }
    });
  }

  function schedulePaintEpg() {
    if (epgPaintTimer) return;
    epgPaintTimer = setTimeout(function () { epgPaintTimer = null; paintEpg(); }, 400);
  }

  function chileanChannels() {
    // Solo canales chilenos (igual que en Android): Deportes y "Todos" nunca consultan guía.
    return allChannels.filter(function (ch) { return ch.group === G.CHILE; });
  }

  function loadEpgIfNeeded() {
    if (epgStarted || !allChannels.length) return;
    epgStarted = true;
    var chilean = chileanChannels();
    if (!chilean.length) return;
    // Primero lo que ya está guardado (instantáneo), luego se descarga/actualiza en segundo plano.
    window.Epg.loadCachedNowNext(chilean).then(paintEpg);
    window.Epg.loadNowNext(chilean).then(paintEpg);
  }

  // Logos: si la app queda abierta muchas horas, igual revisa una vez al día si cambió alguno.
  setInterval(function () {
    if (!allChannels.length) return;
    window.LogoCache.prefetch(allChannels.map(function (c) { return c.logo; }));
  }, 60 * 60 * 1000);

  // Mantiene "ahora / siguiente" al día sin volver a descargar nada.
  setInterval(function () {
    if (!epgStarted || current !== "channels") return;
    window.Epg.loadCachedNowNext(chileanChannels()).then(paintEpg);
  }, 60000);

  function openChannels() {
    show("channels");
    var creds = Store.load();
    if (!creds) { logout(); return; }
    buildCategoryChips();

    var cached = Cache.load();
    if (cached) {
      render(cached, "Lista guardada • actualizando…", "info");
      focusInitial();
      loadEpgIfNeeded();
    } else {
      $("loadingPanel").classList.remove("hidden");
    }

    X.loadChannels(creds).then(function (fresh) {
      Cache.save(fresh);
      render(fresh, "Conectado", "ok");
      if (!document.activeElement || !screens.channels.contains(document.activeElement) ||
          document.activeElement === document.body) focusInitial();
      loadEpgIfNeeded();
    }, function (err) {
      if (err instanceof X.InvalidCredentialsError) { logout(); return; }
      $("loadingPanel").classList.add("hidden");
      if (allChannels.length) {
        setStatus("Sin actualización • usando lista guardada", "error");
        loadEpgIfNeeded();
      } else {
        setStatus("No se pudo cargar. Revisa internet.", "error");
        var chip = $("logoutButton");
        chip.focus();
      }
    });
  }

  function focusInitial() {
    var first = grid.querySelector(".card");
    if (first) first.focus();
    else $("logoutButton").focus();
  }

  function logout() {
    Store.clear();
    Cache.clear();
    // Los logos NO se borran al cerrar sesión: si vuelves a entrar con la misma lista no se descargan de nuevo.
    // Si entras con otra lista, los que ya no se usan se borran solos (prune).
    allChannels = [];
    filtered = [];
    epgStarted = false;
    Object.keys(window.Epg.cache).forEach(function (k) { delete window.Epg.cache[k]; });
    openLogin();
  }

  /* ====================================================================
   *  REPRODUCTOR
   * ==================================================================== */
  var player = window.TvPlayer;
  var playerList = [];
  var currentIndex = -1;
  var currentChannel = null;
  var retryCount = 0;
  var generation = 0;
  var lastZapAt = 0;
  var infoTimer = null;
  var retryTimer = null;
  var returnGroup = G.CHILE;

  var infoPanel = $("infoPanel");
  var loadingBox = $("playerLoading");
  var loadingText = $("playerLoadingText");

  function isGuideChannel(ch) { return ch && ch.group === G.CHILE; }

  function clearTimers() {
    if (infoTimer) { clearTimeout(infoTimer); infoTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  function openPlayer(channel) {
    returnGroup = selectedGroup;
    playerList = allChannels.filter(function (c) { return c.group === selectedGroup; })
      .sort(function (a, b) { return a.sortKey < b.sortKey ? -1 : (a.sortKey > b.sortKey ? 1 : 0); });
    if (!playerList.some(function (c) { return c.id === channel.id; })) {
      playerList = allChannels.slice().sort(function (a, b) { return a.sortKey < b.sortKey ? -1 : (a.sortKey > b.sortKey ? 1 : 0); });
    }
    currentIndex = -1;
    for (var i = 0; i < playerList.length; i++) {
      if (playerList[i].id === channel.id) { currentIndex = i; break; }
    }
    show("player");
    playChannel(channel);
  }

  var currentUrl = "";

  // Misma dirección pero con la otra extensión (m3u8 <-> ts), para el reintento automático.
  function altUrl(url) {
    var m = /\.(ts|m3u8)$/i.exec(url);
    if (!m) return url;
    return url.replace(/\.(ts|m3u8)$/i, "." + (m[1].toLowerCase() === "ts" ? "m3u8" : "ts"));
  }

  function startStream(url) {
    currentUrl = url;
    player.open(url);
  }

  function playChannel(ch) {
    currentChannel = ch;
    retryCount = 0;
    generation++;
    clearTimers();

    $("playerChannelName").textContent = ch.name;
    fillLogoBox($("playerLogoBox"), ch);
    updateEpgInfo(ch);
    showInfo();
    loadingBox.classList.remove("hidden");
    loadingText.textContent = "Abriendo " + ch.name + "…";

    startStream(ch.streamUrl);
  }

  function showInfo() {
    infoPanel.classList.remove("hidden");
    if (infoTimer) clearTimeout(infoTimer);
    infoTimer = setTimeout(function () { infoPanel.classList.add("hidden"); }, 6000);
  }

  function toggleInfo() {
    if (infoTimer) { clearTimeout(infoTimer); infoTimer = null; }
    if (!infoPanel.classList.contains("hidden")) {
      infoPanel.classList.add("hidden");
    } else {
      updateEpgInfo(currentChannel);
      showInfo();
    }
  }

  function updateEpgInfo(ch) {
    var info = isGuideChannel(ch) ? window.Epg.cache[ch.id] : null;
    var now = info && info.now;
    var next = info && info.next;
    var hasGuide = !!(now || next);

    var nowEl = $("playerEpgNow"), timeEl = $("playerEpgTime"), nextEl = $("playerEpgNext");
    var bar = $("playerEpgBar"), badge = $("playerGuideBadge"), hint = $("playerHint");

    if (!hasGuide) {
      nowEl.textContent = ""; nowEl.classList.add("hidden");
      timeEl.textContent = ""; timeEl.classList.add("hidden");
      nextEl.textContent = ""; nextEl.classList.add("hidden");
      bar.classList.add("hidden");
      badge.classList.add("hidden");
      hint.textContent = "↑ ↓ / CH cambia canal   •   OK info   •   BACK vuelve";
      return;
    }

    badge.classList.remove("hidden");
    nowEl.classList.remove("hidden");
    timeEl.classList.remove("hidden");
    hint.textContent = "↑ ↓ / CH cambia canal   •   OK info   •   → guía   •   BACK vuelve";

    if (now) {
      nowEl.textContent = now.title;
      timeEl.textContent = formatTime(now.startMs) + " – " + formatTime(now.stopMs);
      var duration = Math.max(1, now.stopMs - now.startMs);
      var elapsed = Math.min(duration, Math.max(0, Date.now() - now.startMs));
      $("playerEpgFill").style.width = Math.floor(elapsed * 100 / duration) + "%";
      bar.classList.remove("hidden");
    } else {
      nowEl.textContent = next ? next.title : "";
      timeEl.textContent = next ? "Desde " + formatTime(next.startMs) : "";
      bar.classList.add("hidden");
    }

    if (next && next !== now) {
      nextEl.textContent = "Siguiente  •  " + formatTime(next.startMs) + "  " + next.title;
      nextEl.classList.remove("hidden");
    } else {
      nextEl.textContent = "";
      nextEl.classList.add("hidden");
    }
  }

  var RETRY_DELAYS = [650, 1300, 2300, 3500];

  function scheduleRetry() {
    var ch = currentChannel;
    if (!ch) return;
    if (retryCount >= 4) {
      loadingBox.classList.remove("hidden");
      loadingText.textContent = "Este canal no responde. Cambia de canal o vuelve a intentarlo.";
      return;
    }
    var delay = RETRY_DELAYS[retryCount];
    retryCount++;
    var gen = generation;
    loadingBox.classList.remove("hidden");
    loadingText.textContent = "Reconectando…";
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(function () {
      if (gen !== generation) return;
      // Reintentos pares prueban la otra extensión; impares vuelven a la original.
      startStream(retryCount % 2 === 0 ? altUrl(ch.streamUrl) : ch.streamUrl);
    }, delay);
  }

  player.on({
    buffering: function () {
      loadingBox.classList.remove("hidden");
      if (retryCount > 0) loadingText.textContent = "Reconectando…";
    },
    playing: function () {
      // Si funcionó con la otra extensión, la recordamos para este canal.
      if (currentChannel && currentUrl) currentChannel.streamUrl = currentUrl;
      retryCount = 0;
      loadingBox.classList.add("hidden");
    },
    error: function () { if (current === "player") scheduleRetry(); }
  });

  function zap(delta) {
    if (!playerList.length || currentIndex < 0) return;
    var now = Date.now();
    if (now - lastZapAt < 240) return;
    lastZapAt = now;
    currentIndex = (currentIndex + delta + playerList.length) % playerList.length;
    playChannel(playerList[currentIndex]);
  }

  function stopPlayback() {
    clearTimers();
    generation++;
    player.stop();
  }

  function leavePlayer() {
    stopPlayback();
    show("channels");
    var entry = lastFocusedChannelId != null ? cardById[lastFocusedChannelId] : null;
    if (entry) focusEl(entry.el); else focusInitial();
  }

  /* ====================================================================
   *  GUÍA
   * ==================================================================== */
  function openGuide() {
    var ch = currentChannel;
    if (!isGuideChannel(ch) || !window.Epg.cache[ch.id]) return;
    player.pause();
    clearTimers();
    show("guide");

    $("guideChannelName").textContent = ch.name;
    var list = $("guideList");
    list.innerHTML = "";
    $("guideEmpty").classList.add("hidden");
    $("guideLoading").classList.remove("hidden");

    window.Epg.loadSchedule(ch).then(function (schedule) {
      if (current !== "guide") return;
      $("guideLoading").classList.add("hidden");
      if (!schedule.length) { $("guideEmpty").classList.remove("hidden"); return; }

      var t = Date.now();
      var focusRow = null;
      schedule.forEach(function (p) {
        var row = document.createElement("button");
        row.type = "button";
        row.className = "guide-row focusable";
        var isNow = p.startMs <= t && p.stopMs > t;
        if (isNow) row.classList.add("now");

        var time = document.createElement("span");
        time.className = "guide-time";
        time.textContent = formatTime(p.startMs) + " – " + formatTime(p.stopMs);
        var title = document.createElement("span");
        title.className = "guide-title";
        title.textContent = p.title;
        var badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "AHORA";

        row.appendChild(time); row.appendChild(title); row.appendChild(badge);
        list.appendChild(row);
        if (isNow && !focusRow) focusRow = row;
      });
      focusEl(focusRow || list.firstChild);
    });
  }

  function leaveGuide() {
    show("player");
    player.resume();
    showInfo();
  }

  /* ====================================================================
   *  Teclado / control remoto
   * ==================================================================== */
  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
    BACK: 10009, BACK_LG: 461, ESC: 27, EXIT: 10182,
    CH_UP: 427, CH_DOWN: 428, GUIDE: 458, INFO: 457,
    IME_DONE: 65376, IME_CANCEL: 65385   // teclado en pantalla de Samsung
  };

  /* ---------- Cerrar sesión: botón en pantalla + confirmación ---------- */
  var modalReturnFocus = null;

  function openLogoutModal() {
    modalReturnFocus = document.activeElement;
    modalOpen = true;
    $("confirmLogout").classList.remove("hidden");
    $("logoutCancel").focus();            // por defecto queda en "Cancelar"
  }

  function closeLogoutModal() {
    modalOpen = false;
    $("confirmLogout").classList.add("hidden");
    if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
    modalReturnFocus = null;
  }

  $("logoutButton").addEventListener("click", openLogoutModal);
  $("logoutCancel").addEventListener("click", closeLogoutModal);
  $("logoutConfirm").addEventListener("click", function () {
    closeLogoutModal();
    stopPlayback();
    logout();
  });

  function isTextInput(el) {
    return el && el.tagName === "INPUT";
  }

  function onBack() {
    if (modalOpen) { closeLogoutModal(); return; }
    if (current === "player") leavePlayer();
    else if (current === "guide") leaveGuide();
    else exitApp();   // login y canales: BACK cierra la app, como en Android
  }

  document.addEventListener("keydown", function (e) {
    var k = e.keyCode;

    if (k === KEY.EXIT) { exitApp(); return; }

    // Teclado en pantalla: "Listo" pasa al siguiente campo; "Cancelar" solo lo cierra.
    if (isTextInput(e.target) && (k === KEY.IME_DONE || k === KEY.IME_CANCEL)) {
      e.preventDefault();
      if (k === KEY.IME_DONE) move("down"); else e.target.blur();
      return;
    }

    if (k === KEY.BACK || k === KEY.BACK_LG || k === KEY.ESC) {
      e.preventDefault();
      onBack();
      return;
    }

    if (modalOpen) {
      // Con la pregunta abierta solo se mueve entre los dos botones; OK activa el botón enfocado.
      if (k === KEY.LEFT) { e.preventDefault(); move("left"); }
      else if (k === KEY.RIGHT) { e.preventDefault(); move("right"); }
      else if (k === KEY.UP || k === KEY.DOWN) { e.preventDefault(); }
      return;
    }

    if (current === "player") {
      switch (k) {
        case KEY.UP:
        case KEY.CH_UP:
        case 33: case 166:   // PageUp / ChannelUp según el modelo de control
          e.preventDefault(); zap(-1); return;
        case KEY.DOWN:
        case KEY.CH_DOWN:
        case 34: case 167:   // PageDown / ChannelDown
          e.preventDefault(); zap(1); return;
        case KEY.ENTER:
        case KEY.INFO:    e.preventDefault(); toggleInfo(); return;
        case KEY.RIGHT:
        case KEY.GUIDE:   e.preventDefault(); openGuide(); return;
      }
      return;
    }

    var dir = (k === KEY.LEFT) ? "left" : (k === KEY.RIGHT) ? "right" :
              (k === KEY.UP) ? "up" : (k === KEY.DOWN) ? "down" : null;
    if (!dir) return;
    if (isTextInput(e.target) && (dir === "left" || dir === "right")) return; // mover el cursor del texto
    e.preventDefault();
    move(dir);
  }, true);

  document.addEventListener("visibilitychange", function () {
    if (current !== "player") return;
    if (document.hidden) player.suspend();
    else player.restore();
  });

  /* ====================================================================
   *  Inicio
   * ==================================================================== */
  Store.restore(function (c) { if (c) openChannels(); else openLogin(); });
})();
