/*
 * Turbo Play para Samsung Tizen - configuración
 * La dirección del servidor, el usuario y la contraseña se escriben en la pantalla de inicio.
 */
window.TP_CONFIG = {
  // Formato de los canales en vivo (cuando el servidor es Xtream):
  //   "m3u8" -> HLS (recomendado). En Samsung, AVPlay también reproduce "ts" sin problemas.
  //   "ts"   -> MPEG-TS directo.
  //   "auto" -> el que indique el servidor (container_extension).
  // Si un canal falla, la app alterna automáticamente entre m3u8 y ts al reintentar.
  PREFERRED_EXT: "m3u8",

  // Guía de programación: solo Chile (Deportes y "Todos los canales" no piden guía).
  EPG_URLS: [
    "https://epgshare01.online/epgshare01/epg_ripper_CL1.xml.gz"
  ],

  REQUEST_TIMEOUT_MS: 18000,   // peticiones normales
  BULK_TIMEOUT_MS: 90000       // descargas grandes (lista M3U y guía)
};
