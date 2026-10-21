// PULSE – etapp 1 (prototyp)
// VIKTIGT: allt i TEST_FRIENDS är påhittad testdata. Inga riktiga personer eller positioner.

const TEST_FRIENDS = [
  { name: "Alva",  status: "🎉 Vill hitta på något", minutesAgo: 1,  x: 28, y: 30, c1: "#ff7a59", c2: "#ff4fd8", sharing: true },
  { name: "Noah",  status: "🏠 Hemma",               minutesAgo: 12, x: 72, y: 38, c1: "#3ee08f", c2: "#2bb5ff", sharing: true },
  { name: "Elsa",  status: "🌆 Ute",                 minutesAgo: 3,  x: 40, y: 72, c1: "#ffcc4d", c2: "#ff7a59", sharing: true },
  { name: "Liam",  status: "😴 Pausad delning",      minutesAgo: null, x: 0, y: 0, c1: "#7c5cff", c2: "#2bb5ff", sharing: false },
];

// Positioner äldre än så här räknas inte som "live" (förbereder regeln från etapp 5).
const LIVE_LIMIT_MINUTES = 5;

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

function createAvatar(friend) {
  const el = document.createElement("div");
  el.className = "avatar";
  el.style.setProperty("--c1", friend.c1);
  el.style.setProperty("--c2", friend.c2);
  el.textContent = initials(friend.name);
  return el;
}

function renderMapFriends() {
  const layer = document.getElementById("map-friends");
  TEST_FRIENDS.filter(f => f.sharing).forEach((friend, i) => {
    const btn = document.createElement("button");
    btn.className = "map-friend";
    btn.style.left = friend.x + "%";
    btn.style.top = friend.y + "%";
    btn.style.animationDelay = i * 0.08 + "s";
    btn.setAttribute("aria-label", `${friend.name} (testdata)`);
    btn.appendChild(createAvatar(friend));

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = friend.name;
    btn.appendChild(label);

    btn.addEventListener("click", () => showView("friends"));
    layer.appendChild(btn);
  });
}

function renderFriendList() {
  const list = document.getElementById("friend-list");
  TEST_FRIENDS.forEach(friend => {
    const li = document.createElement("li");
    li.className = "friend";
    li.appendChild(createAvatar(friend));

    const info = document.createElement("div");
    info.className = "friend-info";
    const name = document.createElement("div");
    name.className = "friend-name";
    name.textContent = friend.name;
    const status = document.createElement("div");
    status.className = "friend-status";
    status.textContent = friend.status;
    info.append(name, status);

    const time = document.createElement("div");
    time.className = "friend-time" + (friend.sharing ? "" : " paused");
    time.textContent = timeText(friend);

    li.append(info, time);
    list.appendChild(li);
  });
}

function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById("view-" + name).classList.add("active");
  document.querySelectorAll(".nav-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.view === name);
  });
}

// Min position – detta är ÄKTA: den använder mobilens GPS via webbläsaren.
function showLocationCard(title, text) {
  document.getElementById("location-title").textContent = title;
  document.getElementById("location-text").textContent = text;
  document.getElementById("location-card").hidden = false;
}

function showMeDot() {
  if (document.querySelector(".me-dot")) return;
  const dot = document.createElement("div");
  dot.className = "me-dot";
  dot.setAttribute("aria-label", "Du");
  document.getElementById("map").appendChild(dot);
}

function locateMe() {
  const btn = document.getElementById("locate-btn");

  if (!("geolocation" in navigator)) {
    showLocationCard("Fungerar inte", "Din webbläsare kan inte hämta position.");
    return;
  }
  if (!window.isSecureContext) {
    showLocationCard("Kräver https", "Position fungerar bara när sidan öppnas via en https-länk.");
    return;
  }

  btn.classList.add("loading");
  navigator.geolocation.getCurrentPosition(
    pos => {
      btn.classList.remove("loading");
      const { latitude, longitude, accuracy } = pos.coords;
      showMeDot();
      showLocationCard(
        "📍 Din position (äkta)",
        `Lat ${latitude.toFixed(5)}, Long ${longitude.toFixed(5)} · ungefär ±${Math.round(accuracy)} m. ` +
        "Pricken på kartan är bara en symbol tills den riktiga kartan kommer i etapp 2."
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

renderMapFriends();
renderFriendList();

// Gör appen installerbar (PWA). Misslyckas tyst om det inte stöds.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
