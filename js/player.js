/*
 * Reproductor para Samsung Tizen.
 *   - En la TV usa AVPlay (reproductor nativo de Samsung): HLS (.m3u8) y MPEG-TS (.ts) directo.
 *   - Fuera de la TV (navegador de PC) usa <video> HTML5, para poder probar la interfaz.
 *
 * TvPlayer.on(handlers)  handlers = { buffering(), playing(), error() }
 * TvPlayer.open(url) / pause() / resume() / suspend() / restore() / stop()
 * TvPlayer.usesAvplay    true si se usa el reproductor nativo
 */
(function () {
  var av = (window.webapis && window.webapis.avplay) ? window.webapis.avplay : null;
  var video = document.getElementById("video");
  var avObject = document.getElementById("av-player");
  var handlers = {};
  var token = 0;           // descarta eventos de canales anteriores
  var watchdog = null;
  var START_TIMEOUT_MS = 20000;

  function emit(name, myToken) {
    if (myToken !== undefined && myToken !== token) return;
    if (name !== "buffering") clearWatchdog();
    var h = handlers[name];
    if (h) { try { h(); } catch (e) {} }
  }

  function clearWatchdog() { if (watchdog) { clearTimeout(watchdog); watchdog = null; } }
  function armWatchdog(myToken) {
    clearWatchdog();
    watchdog = setTimeout(function () { watchdog = null; emit("error", myToken); }, START_TIMEOUT_MS);
  }

  /* ---------- AVPlay ---------- */
  function avState() { try { return av.getState(); } catch (e) { return "NONE"; } }

  function avClose() {
    try {
      var st = avState();
      if (st === "PLAYING" || st === "PAUSED" || st === "READY") av.stop();
    } catch (e) {}
    try { av.close(); } catch (e) {}
  }

  function avOpen(url, myToken) {
    avClose();
    try {
      av.open(url);
      av.setDisplayRect(0, 0, 1920, 1080);   // AVPlay siempre usa coordenadas base 1920x1080
      try { av.setDisplayMethod("PLAYER_DISPLAY_MODE_LETTER_BOX"); } catch (e) {}
      av.setListener({
        onbufferingstart: function () { emit("buffering", myToken); },
        onbufferingprogress: function () {},
        onbufferingcomplete: function () { if (avState() === "PLAYING") emit("playing", myToken); },
        onstreamcompleted: function () { emit("error", myToken); },   // un canal en vivo no debería terminar
        oncurrentplaytime: function () {},
        onevent: function () {},
        onerror: function () { emit("error", myToken); },
        ondrmevent: function () {},
        onsubtitlechange: function () {}
      });
      av.prepareAsync(function () {
        if (myToken !== token) return;
        try { av.play(); emit("playing", myToken); } catch (e) { emit("error", myToken); }
      }, function () { emit("error", myToken); });
    } catch (e) {
      setTimeout(function () { emit("error", myToken); }, 0);
    }
  }

  /* ---------- HTML5 video (respaldo) ---------- */
  if (video) {
    video.addEventListener("waiting", function () { if (!av) emit("buffering", token); });
    video.addEventListener("playing", function () { if (!av) emit("playing", token); });
    video.addEventListener("error", function () { if (!av && video.getAttribute("src")) emit("error", token); });
    video.addEventListener("ended", function () { if (!av) emit("error", token); });
  }

  function videoOpen(url) {
    try {
      video.src = url;
      video.load();
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) { setTimeout(function () { emit("error", token); }, 0); }
  }

  /* ---------- API ---------- */
  if (av) {
    if (video) video.style.display = "none";
    document.documentElement.classList.add("avplay");
  } else if (avObject) {
    avObject.style.display = "none";
  }

  window.TvPlayer = {
    usesAvplay: !!av,
    on: function (h) { handlers = h || {}; },
    open: function (url) {
      token++;
      armWatchdog(token);
      emit("buffering", token);
      if (av) avOpen(url, token); else videoOpen(url);
    },
    pause: function () {
      if (av) { try { if (avState() === "PLAYING") av.pause(); } catch (e) {} }
      else { try { video.pause(); } catch (e) {} }
    },
    resume: function () {
      if (av) { try { if (avState() === "PAUSED") av.play(); } catch (e) {} }
      else { try { var p = video.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
    },
    // Al pasar la app a segundo plano (botón HOME) y al volver.
    suspend: function () {
      if (av) { try { av.suspend(); } catch (e) {} }
      else { try { video.pause(); } catch (e) {} }
    },
    restore: function () {
      if (av) { try { av.restore(); } catch (e) {} }
      else { try { var p = video.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
    },
    stop: function () {
      token++;
      clearWatchdog();
      if (av) avClose();
      else { try { video.pause(); video.removeAttribute("src"); video.load(); } catch (e) {} }
    }
  };
})();
