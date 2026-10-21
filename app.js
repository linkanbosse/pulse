// PULSE – karta (etapp 2) och vänner på kartan (etapp 5).
// Kartan är äkta: MapLibre GL JS (ritar kartan) + OpenFreeMap (gratis kartdata från OpenStreetMap).
// Vännerna på kartan är riktiga: location.js hämtar dem från Supabase och anropar renderFriendMarkers().

// En position räknas som "live" bara om den är högst så här gammal. Äldre visas gråa med tid.
const LIVE_LIMIT_SECONDS = 120;

// Kartinställningar. OpenFreeMap är gratis, utan konto och API-nyckel, och tillåter kommersiell användning.
const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
const DEFAULT_CENTER = { lat: 59.8360, lng: 13.1430 }; // Sunne, bara om appen aldrig har fått din position
// Ungefär var du var senast (avrundat till ~100 m). Sparas bara i den här webbläsaren, så att kartan
// kan starta nära dig direkt medan GPS:en letar. Raderas när du loggar ut.
const LAST_CENTER_KEY = "pulse-last-center";
const DEFAULT_ZOOM = 14;
const ME_ZOOM = 15;

let map = null;
let mapReady = false;
let meMarker = null;
let userMovedMap = false; // du har själv dragit eller zoomat kartan
let startedAtMe = false;  // true när kartan redan har flyttats till dig vid start
let myAccuracy = null; // { lat, lng, meters } – ritas som en ring när kartan är klar
const friendMarkers = new Map();

// "nyss", "4 min sedan", "2 h sedan". Sekunderna räknas av servern (se location.js).
function ageText(seconds) {
  if (seconds < 60) return "nyss";
  if (seconds < 3600) return Math.floor(seconds / 60) + " min sedan";
  return Math.floor(seconds / 3600) + " h sedan";
}

function clockText(secondsAgo) {
  return new Date(Date.now() - secondsAgo * 1000).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
}

function friendTimeText(friend) {
  if (friend.age_seconds <= LIVE_LIMIT_SECONDS) return "Live · " + ageText(friend.age_seconds);
  return `Senast ${clockText(friend.age_seconds)} · ${ageText(friend.age_seconds)}`;
}

function showFriendCard(friend) {
  const live = friend.age_seconds <= LIVE_LIMIT_SECONDS;
  showLocationCard(
    (live ? "🟢 " : "⚪ ") + friend.display_name,
    `${friendTimeText(friend)} · ungefär ±${Math.round(friend.accuracy_m)} m.` +
    (live ? "" : " Det här är var hen var senast, inte var hen är nu."),
    false
  );
}

// ---------- Karta ----------

function showMapError(text) {
  const box = document.getElementById("map-error");
  box.textContent = text;
  box.hidden = false;
}

// Ger kartan PULSE-färger (lila-blå ton) i stället för OpenFreeMaps neutralt grå mörka stil.
function tintMap() {
  const paint = [
    ["background", "background-color", "#151526"],
    ["water", "fill-color", "#173a5c"],
    ["waterway", "line-color", "#173a5c"],
    ["landuse_park", "fill-color", "#18392a"],
    ["landcover_wood", "fill-color", "#18392a"],
    ["building", "fill-color", "#1f1f36"],
    ["building", "fill-outline-color", "#2a2a46"],
    ["highway_path", "line-color", "#33335a"],
    ["highway_minor", "line-color", "#2c2c4a"],
    ["highway_major_casing", "line-color", "#4a4a78"],
    ["highway_major_inner", "line-color", "#3a3a62"],
    ["highway_major_subtle", "line-color", "#3a3a62"],
    ["highway_motorway_casing", "line-color", "#6a55c0"],
    ["highway_motorway_inner", "line-color", "#4c3f96"],
    ["highway_motorway_subtle", "line-color", "#4c3f96"],
  ];
  paint.forEach(([layer, prop, value]) => {
    if (map.getLayer(layer)) map.setPaintProperty(layer, prop, value);
  });
  // Lite ljusare text så att gatunamn och orter går att läsa på mobilen.
  map.getStyle().layers.forEach(layer => {
    if (layer.type === "symbol" && layer.layout && layer.layout["text-field"]) {
      map.setPaintProperty(layer.id, "text-color", "#b4b4d2");
    }
  });
}

// En cirkel (som polygon) runt din position som visar hur säker GPS:en är.
function circlePolygon(lat, lng, meters) {
  const points = [];
  const dLat = meters / 111320;
  const dLng = meters / (111320 * Math.cos(lat * Math.PI / 180));
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    points.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [points] }, properties: {} };
}

function drawAccuracy() {
  if (!mapReady || !myAccuracy) return;
  const data = circlePolygon(myAccuracy.lat, myAccuracy.lng, myAccuracy.meters);
  const source = map.getSource("me-accuracy");
  if (source) {
    source.setData(data);
    return;
  }
  map.addSource("me-accuracy", { type: "geojson", data });
  map.addLayer({ id: "me-accuracy-fill", type: "fill", source: "me-accuracy", paint: { "fill-color": "#4da3ff", "fill-opacity": 0.12 } });
  map.addLayer({ id: "me-accuracy-line", type: "line", source: "me-accuracy", paint: { "line-color": "#4da3ff", "line-opacity": 0.5, "line-width": 1.5 } });
}

// Ritar vänner som delar sin position med dig. friends = rader från get_friend_locations med state "sharing".
function renderFriendMarkers(friends) {
  if (!map) return;
  const seen = new Set();
  friends.forEach((friend, i) => {
    seen.add(friend.user_id);
    const live = friend.age_seconds <= LIVE_LIMIT_SECONDS;
    let entry = friendMarkers.get(friend.user_id);

    if (!entry) {
      // MapLibre flyttar det yttre elementet; animationen ligger på knappen inuti.
      const wrap = document.createElement("div");
      const btn = document.createElement("button");
      btn.className = "map-friend";
      btn.style.animationDelay = i * 0.08 + "s";
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      const label = document.createElement("span");
      label.className = "label";
      btn.append(avatar, label);
      btn.addEventListener("click", event => {
        event.stopPropagation();
        showFriendCard(entry.friend);
      });
      wrap.appendChild(btn);
      const marker = new maplibregl.Marker({ element: wrap, anchor: "bottom" })
        .setLngLat([friend.lng, friend.lat])
        .addTo(map);
      entry = { marker, btn, avatar, label, friend };
      friendMarkers.set(friend.user_id, entry);
    }

    entry.friend = friend;
    entry.marker.setLngLat([friend.lng, friend.lat]);
    paintAvatar(entry.avatar, friend.display_name, friend.avatar_color);
    entry.btn.classList.toggle("stale", !live);
    entry.btn.setAttribute("aria-label", `${friend.display_name}, ${friendTimeText(friend)}`);
    entry.label.textContent = friend.display_name + (live ? "" : " · " + ageText(friend.age_seconds));
  });

  friendMarkers.forEach((entry, id) => {
    if (!seen.has(id)) {
      entry.marker.remove();
      friendMarkers.delete(id);
    }
  });
}

function initMap() {
  if (typeof maplibregl === "undefined") {
    showMapError("Kartan kunde inte laddas. Kontrollera internet och ladda om sidan.");
    return;
  }
  try {
    map = new maplibregl.Map({
      container: "map-canvas",
      style: MAP_STYLE_URL,
      center: (c => [c.lng, c.lat])(readLastCenter() || DEFAULT_CENTER),
      zoom: DEFAULT_ZOOM,
      maxPitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: false,
      locale: {
        "AttributionControl.ToggleAttribution": "Visa kartans källor",
      },
    });
  } catch (e) {
    showMapError("Din webbläsare kan inte visa kartan (WebGL saknas eller är avstängt).");
    return;
  }

  // Källhänvisningen krävs av OpenStreetMap/OpenFreeMap. Nere till vänster så att den inte krockar med positionsknappen.
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

  // Bara vridning med två fingrar stängs av, zoom med två fingrar fungerar som vanligt.
  map.touchZoomRotate.disableRotation();

  // Bara riktiga fingerrörelser räknas (originalEvent), inte när appen själv flyttar kartan.
  map.on("dragstart", () => { userMovedMap = true; });
  map.on("zoomstart", event => { if (event.originalEvent) userMovedMap = true; });

  map.on("load", () => {
    mapReady = true;
    tintMap();
    drawAccuracy();
  });

  map.on("error", event => {
    // Fel innan kartan hunnit laddas betyder oftast att mobilen saknar internet.
    if (!mapReady) {
      showMapError("Kartan kunde inte hämtas just nu. Kontrollera internet och ladda om sidan.");
      return;
    }
    // Om kartbitarna inte går att hämta blir kartan tom. Säg det i stället för att visa en svart yta.
    if (event && event.sourceId === "openmaptiles") {
      showMapError("Kartbilderna kunde inte hämtas. Kontrollera internet, eller stäng av annonsblockerare för sidan, och ladda om.");
    }
  });
}

function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById("view-" + name).classList.add("active");
  document.querySelectorAll(".nav-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.view === name);
  });
  // Kartan var dold medan en annan flik visades och behöver mäta om sin storlek.
  if (name === "map" && map) map.resize();
}

// ---------- Min position (ÄKTA: mobilens GPS via webbläsaren) ----------

function showLocationCard(title, text, showPrivacyNote = true) {
  document.getElementById("location-title").textContent = title;
  document.getElementById("location-fine").hidden = !showPrivacyNote;
  document.getElementById("location-text").textContent = text;
  document.getElementById("location-card").hidden = false;
  // Läses upp av skärmläsare, eftersom själva kortet var dolt innan.
  document.getElementById("location-status").textContent = title + ". " + text;
}

// fly = true flyttar kartan till dig. Automatiska uppdateringar (location.js) flyttar bara pricken.
function showMe(lat, lng, accuracy, fly = true) {
  myAccuracy = { lat, lng, meters: accuracy };
  saveLastCenter(lat, lng);
  if (!map) return;

  if (!meMarker) {
    const dot = document.createElement("div");
    dot.className = "me-dot";
    dot.setAttribute("aria-label", "Du");
    meMarker = new maplibregl.Marker({ element: dot }).setLngLat([lng, lat]).addTo(map);
  } else {
    meMarker.setLngLat([lng, lat]);
  }
  drawAccuracy();

  // Lite förskjutning uppåt så att pricken inte hamnar bakom positionskortet.
  if (fly) map.flyTo({ center: [lng, lat], zoom: ME_ZOOM, offset: [0, -80] });
}

function readLastCenter() {
  try {
    const c = JSON.parse(localStorage.getItem(LAST_CENTER_KEY));
    if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) return c;
  } catch (e) {
    // Privat läge eller blockerad lagring: starta i Sunne.
  }
  return null;
}

function saveLastCenter(lat, lng) {
  try {
    localStorage.setItem(LAST_CENTER_KEY, JSON.stringify({ lat: Math.round(lat * 1000) / 1000, lng: Math.round(lng * 1000) / 1000 }));
  } catch (e) {}
}

function forgetLastCenter() {
  try { localStorage.removeItem(LAST_CENTER_KEY); } catch (e) {}
}

// När appen öppnas: hämta din position direkt och visa kartan där du är.
// Har du nekat platsåtkomst frågar appen inte igen, utan stannar där den var.
async function locateOnStart() {
  if (!map || !("geolocation" in navigator) || !window.isSecureContext) return;
  try {
    if (navigator.permissions) {
      const state = (await navigator.permissions.query({ name: "geolocation" })).state;
      if (state === "denied") return;
    }
  } catch (e) {
    // Äldre Safari saknar permissions-frågan. Då frågar vi som vanligt.
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      // Har du hunnit flytta kartan själv, eller trycka på positionsknappen, rör vi den inte.
      const { latitude, longitude, accuracy } = pos.coords;
      showMe(latitude, longitude, accuracy, false);
      if (!startedAtMe && !userMovedMap) map.jumpTo({ center: [longitude, latitude], zoom: ME_ZOOM });
      startedAtMe = true;
    },
    () => {},
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

function locateMe() {
  const btn = document.getElementById("locate-btn");
  // Ignorera nya tryck medan en sökning pågår, så att ett gammalt svar inte skriver över ett nytt.
  if (btn.classList.contains("loading")) return;

  if (!("geolocation" in navigator)) {
    showLocationCard("Fungerar inte", "Din webbläsare kan inte hämta position.");
    return;
  }
  if (!window.isSecureContext) {
    showLocationCard("Kräver https", "Position fungerar bara när sidan öppnas via en https-länk.");
    return;
  }

  // Positionen hämtas först nu, när du själv har tryckt. Webbläsaren frågar om lov första gången.
  btn.classList.add("loading");
  startedAtMe = true; // knappen flyttar kartan själv, startpositionen ska inte hoppa dit igen
  navigator.geolocation.getCurrentPosition(
    pos => {
      btn.classList.remove("loading");
      const { latitude, longitude, accuracy } = pos.coords;
      const time = new Date(pos.timestamp).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
      showMe(latitude, longitude, accuracy);
      // location.js skickar positionen till de vänner du har valt, om du delar (annars händer inget).
      const shared = typeof onMyPosition === "function" ? onMyPosition(pos) : false;
      showLocationCard(
        "📍 Din position",
        `Uppdaterad ${time} · ungefär ±${Math.round(accuracy)} m (blå ring). ` +
        (shared
          ? "Du delar din position, så den uppdateras av sig själv medan appen är öppen."
          : "Uppdateras inte av sig själv, tryck igen för en ny."),
        !shared
      );
    },
    err => {
      btn.classList.remove("loading");
      const messages = {
        1: "Du nekade platsåtkomst. Tryck på hänglåset/inställningar vid adressfältet och tillåt Plats för sidan, och försök igen.",
        2: "Positionen kunde inte hittas. Slå på Plats i mobilens snabbinställningar och försök igen.",
        3: "Det tog för lång tid. Försök igen, gärna utomhus eller nära ett fönster.",
      };
      showLocationCard("Ingen position", messages[err.code] || "Okänt fel: " + err.message);
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});
document.getElementById("locate-btn").addEventListener("click", locateMe);
document.getElementById("location-close").addEventListener("click", () => {
  document.getElementById("location-card").hidden = true;
});

initMap();
locateOnStart();

// Gör appen installerbar (PWA). Misslyckas tyst om det inte stöds.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
