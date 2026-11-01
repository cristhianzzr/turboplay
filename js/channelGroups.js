/*
 * Port de ChannelGroups.kt: clasificación en tres grupos
 * (Canales chilenos, Deportes, Todos los canales).
 */
(function () {
  var CHILE = "turbo:chile";
  var SPORTS = "turbo:sports";
  var REMAINING = "turbo:remaining";

  var SPORTS_WORDS = [
    "deporte", "deportes", "sport", "sports", "futbol", "football", "soccer",
    "espn", "tnt sports", "fox sports", "dsports", "directv sports", "bein sports",
    "gol tv", "goltv", "golf", "tenis", "tennis", "padel", "rugby", "nba", "nfl",
    "mlb", "nhl", "ufc", "wwe", "formula 1", "formula1", "f1 ", "motogp",
    "motor sport", "motorsport", "racing", "fight", "combate", "cancha", "estadio",
    "tyc sports", "claro sports"
  ];

  var CHILE_CHANNELS = [
    "tvn", "television nacional", "mega", "megatiempo", "chilevision", "chv",
    "canal 13", "13c", "13 rec", "rec tv", "t13", "la red", "telecanal",
    "tv+", "tv plus", "tv mas", "24 horas", "ntv", "cnn chile", "tv chile",
    "zona latina", "via x", "biobio tv", "bio bio tv", "canal 9 biobio",
    "tvu", "ucv tv", "ucvtv", "ucv television", "pucv tv", "tv senado",
    "camara de diputados", "canal 2 san antonio", "canal 21", "canal 22",
    "quinta vision", "contivision", "atv valdivia", "campus tv", "umag tv",
    "antofagasta tv", "ar tv", "nueva region tv", "autonoma tv", "wapp",
    "pauta", "tv hits", "vision plus tv"
  ];

  function stripAccents(value) {
    var s = String(value || "");
    if (s.normalize) s = s.normalize("NFD");
    return s.replace(/[\u0300-\u036f]+/g, "");
  }

  function normalize(value) {
    return stripAccents(value)
      .toLowerCase()
      .replace(/[^a-z0-9+|:\[\] ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function sortKey(value) {
    return stripAccents(value).toLowerCase().trim();
  }

  function isSports(text) {
    return SPORTS_WORDS.some(function (w) { return text.indexOf(w) !== -1; });
  }

  function isChilean(name, category) {
    if (name.indexOf("canal feliz") !== -1 || name.indexOf("thema television") !== -1) return false;

    if (category.indexOf("chile") !== -1 || category.indexOf("chileno") !== -1 ||
        category.indexOf("chilena") !== -1) return true;

    if (name.indexOf("cl ") === 0 || name.indexOf("cl:") === 0 || name.indexOf("cl|") === 0 ||
        name.indexOf("[cl]") === 0 || name.indexOf(" chile ") !== -1 ||
        /\schile$/.test(name)) return true;

    return CHILE_CHANNELS.some(function (token) {
      return name === token ||
        name.indexOf(token + " ") === 0 ||
        name.slice(-(token.length + 1)) === " " + token ||
        name.indexOf(" " + token + " ") !== -1;
    });
  }

  function classify(channel, sourceCategoryName) {
    var name = normalize(channel.name);
    var category = normalize(sourceCategoryName || "");
    var combined = category + " " + name;
    if (isSports(combined)) return SPORTS;
    if (isChilean(name, category)) return CHILE;
    return REMAINING;
  }

  function isChileanChannel(channel, sourceCategoryName) {
    return isChilean(normalize(channel.name), normalize(sourceCategoryName || ""));
  }

  window.ChannelGroups = {
    CHILE: CHILE,
    SPORTS: SPORTS,
    REMAINING: REMAINING,
    classify: classify,
    isChileanChannel: isChileanChannel,
    sortKey: sortKey
  };
})();
