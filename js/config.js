/*
 * Turbo Play para Samsung Tizen - configuración
 * La dirección del servidor, el usuario y la contraseña se escriben en la pantalla de inicio.
 */
window.TP_CONFIG = {
  // Servidor Xtream fijo. Si tiene una dirección, la app NO la pide: solo usuario y contraseña.
  // Déjalo vacío ("") para volver a pedir la dirección del servidor (o una lista M3U).
  FIXED_SERVER: "http://213.186.32.5:25461",

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
