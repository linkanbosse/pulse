// PULSE – karta (etapp 2). Riktiga vänner finns i friends.js (etapp 4).
// VIKTIGT: allt i TEST_FRIENDS är påhittad testdata som bara visas på kartan, tills platsdelning kommer i etapp 5.
// Kartan är äkta: MapLibre GL JS (ritar kartan) + OpenFreeMap (gratis kartdata från OpenStreetMap).

// Testvännernas plats anges som en förskjutning (i grader) från en mittpunkt.
// Innan du har visat din position är mittpunkten Stockholm; efteråt flyttas testvännerna runt dig.
const TEST_FRIENDS = [
  { name: "Alva",  status: "🎉 Vill hitta på något", minutesAgo: 1,  dLat:  0.0012, dLng: -0.0024, c1: "#ff7a59", c2: "#ff4fd8", sharing: true },
  { name: "Noah",  status: "🏠 Hemma",               minutesAgo: 12, dLat:  0.0008, dLng:  0.0026, c1: "#3ee08f", c2: "#2bb5ff", sharing: true },
  { name: "Elsa",  status: "🌆 Ute",                 minutesAgo: 3,  dLat: -0.0011, dLng:  0.0020, c1: "#ffcc4d", c2: "#ff7a59", sharing: true },
  { name: "Liam",  status: "😴 Pausad delning",      minutesAgo: null, dLat: 0, dLng: 0, c1: "#7c5cff", c2: "#2bb5ff", sharing: false },
];

// Positioner äldre än så här räknas inte som "live" (förbereder regeln från etapp 5).
const LIVE_LIMIT_MINUTES = 5;

// Kartinställningar. OpenFreeMap är gratis, utan konto och API-nyckel, och tillåter kommersiell användning.
const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
const DEFAULT_CENTER = { lat: 59.3293, lng: 18.0686 }; // Stockholm, används tills du själv visar din position
const DEFAULT_ZOOM = 14;
const ME_ZOOM = 15;

let map = null;
let mapReady = false;
let anchor = DEFAULT_CENTER;
let meMarker = null;
let myAccuracy = null; // { lat, lng, meters } – ritas som en ring när kartan är klar
const friendMarkers = new Map();

function initials(name) {
  return name.slice(0, 1).toUpperCase();
}

function timeText(friend) {
  if (!friend.sharing) return "Delar inte";
  if (friend.minutesAgo <= LIVE_LIMIT_MINUTES) {
    return friend.minutesAgo <= 1 ? "Live · nyss" : `Live · ${friend.minutesAgo} min sedan`;
  }
  return `Senast ${friend.minutesAgo} min sedan`;
}

function friendPosition(friend) {
  return { lat: anchor.lat + friend.dLat, lng: anchor.lng + friend.dLng };
}

function createAvatar(friend) {
  const el = document.createElement("div");
  el.className = "avatar";
  el.style.setProperty("--c1", friend.c1);
  el.style.setProperty("--c2", friend.c2);
  el.textContent = initials(friend.name);
  return el;
}

function showFriendCard(friend) {
  showLocationCard(`${friend.name} (testdata)`, `${friend.status} · ${timeText(friend)}. Påhittad person och plats.`, false);
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

function renderMapFriends() {
  TEST_FRIENDS.filter(f => f.sharing).forEach((friend, i) => {
    const pos = friendPosition(friend);
    if (friendMarkers.has(friend.name)) {
      friendMarkers.get(friend.name).setLngLat([pos.lng, pos.lat]);
      return;
    }

    // MapLibre flyttar det yttre elementet; animationen ligger på knappen inuti.
    const wrap = document.createElement("div");
    const btn = document.createElement("button");
    btn.className = "map-friend";
    btn.style.animationDelay = i * 0.08 + "s";
    btn.setAttribute("aria-label", `${friend.name} (testdata)`);
    btn.appendChild(createAvatar(friend));

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = friend.name + " · test";
    btn.appendChild(label);

    btn.addEventListener("click", event => {
      event.stopPropagation();
      showFriendCard(friend);
    });
    wrap.appendChild(btn);

    const marker = new maplibregl.Marker({ element: wrap, anchor: "bottom" })
      .setLngLat([pos.lng, pos.lat])
      .addTo(map);
    friendMarkers.set(friend.name, marker);
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
      center: [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat],
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

  renderMapFriends();
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

function showMe(lat, lng, accuracy) {
  myAccuracy = { lat, lng, meters: accuracy };
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

  // Flytta testvännerna runt dig, så att du ser hur det kommer att se ut.
  anchor = { lat, lng };
  renderMapFriends();

  // Lite förskjutning uppåt så att pricken inte hamnar bakom positionskortet.
  map.flyTo({ center: [lng, lat], zoom: ME_ZOOM, offset: [0, -80] });
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
  navigator.geolocation.getCurrentPosition(
    pos => {
      btn.classList.remove("loading");
      const { latitude, longitude, accuracy } = pos.coords;
      const time = new Date(pos.timestamp).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
      showMe(latitude, longitude, accuracy);
      showLocationCard(
        "📍 Din position (äkta)",
        `Uppdaterad ${time} · ungefär ±${Math.round(accuracy)} m (blå ring). ` +
        "Uppdateras inte av sig själv, tryck igen för en ny. Vännerna runt dig är påhittade testdata."
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

// Gör appen installerbar (PWA). Misslyckas tyst om det inte stöds.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
