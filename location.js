// PULSE – etapp 5: platsdelning (Supabase)
// ÄKTA: välja vilka vänner som får se dig, skicka din position medan appen är öppen,
// pausa, osynligt läge, och visa vänner som delar med dig på kartan.
// Allt går via databasfunktionerna i supabase/etapp5-platsdelning.sql. Appen kan inte läsa tabellerna direkt.
// Använder sb, $, showMsg, setBusy, paintAvatar, dbErrorText (account.js) och
// showView, showMe, renderFriendMarkers, ageText, LIVE_LIMIT_SECONDS (app.js).

const FRIENDS_POLL_MS = 15000;   // hämta vännernas positioner så här ofta medan appen syns
const HEARTBEAT_MS = 60000;      // skicka en ny position minst så här ofta, även om du står still
const SEND_MIN_MS = 10000;       // men aldrig oftare än så här
const SEND_MIN_METERS = 25;      // om du har flyttat dig minst så här långt
const MAX_FIX_AGE_MS = 60000;    // en GPS-position som är äldre än så här skickas aldrig
const MAX_ACCURACY_M = 2000;     // sämre noggrannhet än så här skickas inte

let locUser = null;
let locSettings = null;         // svaret från get_my_location_settings
let locFriends = [];            // svaret från get_friend_locations
let locFetchedAt = 0;           // när locFriends hämtades (för att låta tiden gå mellan hämtningarna)
let locLoadId = 0;
let locSetupError = null;
let watchId = null;
let heartbeatTimer = null;
let pollTimer = null;
let pauseTimer = null;
let lastFix = null;             // senaste GPS-svaret { lat, lng, accuracy, time }
let lastSent = null;            // senast skickade { lat, lng, at }
let lastSendResult = null;      // "saved", "error" m.m.
let sending = false;
let sendPromise = null;         // pågående update_my_location, så att utloggning kan vänta in den
let geoDenied = false;
let locatedOnce = false;        // kartan flyttas till dig bara första gången

function locationErrorText(error) {
  if (["PGRST202", "PGRST204", "42883"].includes(error.code)) {
    return "Platsdelningen finns inte i databasen än. Kör filen supabase/etapp5-platsdelning.sql i Supabase SQL Editor och ladda om sidan.";
  }
  if (error.code === "42501") return "Saknar behörighet. Kör filen supabase/etapp5-platsdelning.sql igen i Supabase.";
  const byMessage = {
    not_friends: "Ni är inte vänner längre. Listan har uppdaterats.",
    not_authenticated: "Du är utloggad. Logga in igen.",
    invalid_pause: "Ogiltig paus.",
  };
  return byMessage[error.message] || dbErrorText(error);
}

// Delar jag just nu? (minst en vän vald, inte pausad, inte osynlig)
function sharingActive() {
  return !!(locSettings && locSettings.active);
}

function viewerCount() {
  return locSettings ? locSettings.viewer_ids.length : 0;
}

// Vännens ålder på positionen just nu: serverns sekunder + tiden sedan vi hämtade listan.
// Är mobilen offline fortsätter siffran att växa, så att ingen ser live ut när den inte är det.
function friendsWithCurrentAge() {
  const extra = Math.floor((Date.now() - locFetchedAt) / 1000);
  return locFriends
    .filter(f => f.state === "sharing" && f.lat !== null && f.lng !== null)
    .map(f => ({ ...f, age_seconds: f.age_seconds + extra }));
}

function distanceMeters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
}

function pauseEndText() {
  if (!locSettings || !locSettings.paused) return "";
  if (locSettings.paused_forever) return "tills du startar igen";
  const end = new Date(locSettings.paused_until);
  const sameDay = end.toDateString() === new Date().toDateString();
  return "till " + end.toLocaleString("sv-SE", sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

// ---------- Visa läget (kartchip och Profil → Platsdelning) ----------

// Returnerar [färg, rubrik, förklaring] för läget just nu.
function sharingSummary() {
  const n = viewerCount();
  const who = n === 1 ? "1 vän" : n + " vänner";
  if (locSettings.ghost) return ["ghost", "Osynligt läge", "Ingen ser var du är. Vännerna ser \"delar inte\"."];
  if (locSettings.paused) return ["paused", "Pausad " + pauseEndText(), "Vännerna du valt ser att du har pausat, men inte var du är."];
  if (n === 0) return ["off", "Du delar inte", "Ingen kan se var du är. Välj vänner nedan för att dela."];
  if (geoDenied) return ["warn", "Delar med " + who + ", men platsen är blockerad", "Tillåt Plats för sidan: tryck på hänglåset/ikonen vid adressfältet → Behörigheter → Plats. Ladda sedan om."];
  if (watchId === null) return ["warn", "Delar med " + who + ", men inte igång", "Tryck på \"Börja dela nu\" så hämtar appen din position."];
  if (lastSendResult === "error") return ["warn", "Delar med " + who + ", men senaste skicket misslyckades", "Kontrollera internet. Appen försöker igen av sig själv."];
  if (lastSent && Date.now() - lastSent.at <= LIVE_LIMIT_SECONDS * 1000) {
    return ["live", "Live med " + who, "Din position skickas medan appen är öppen. Stänger du appen ser vännerna var du var senast, med tid."];
  }
  return ["warn", "Delar med " + who + ", väntar på GPS", "Appen väntar på en position från mobilen."];
}

function renderChip() {
  const chip = $("share-chip");
  if (!locUser || !locSettings) {
    // Utloggad eller databasen saknas: visa bara en kort förklaring.
    chip.hidden = !sb;
    $("share-chip-dot").className = "chip-dot off";
    $("share-chip-text").textContent = locUser ? "Platsdelning inte igång" : "Logga in för att se vänner";
    return;
  }
  const [kind, title] = sharingSummary();
  const visible = friendsWithCurrentAge().length;
  chip.hidden = false;
  $("share-chip-dot").className = "chip-dot " + kind;
  $("share-chip-text").textContent = title + (visible ? ` · ${visible} på kartan` : "");
}

function renderSharing() {
  renderChip();
  if (!locUser || !locSettings) {
    $("sharing-box").hidden = true;
    $("sharing-off").hidden = false;
    $("sharing-off-text").textContent = !locUser
      ? "Logga in för att dela din position med vänner. Ingen kan se var du är."
      : (locSetupError || "Laddar platsdelning…");
    return;
  }
  $("sharing-off").hidden = true;
  $("sharing-box").hidden = false;

  const [kind, title, text] = sharingSummary();
  $("sharing-dot").className = "chip-dot " + kind;
  $("sharing-title").textContent = title;
  $("sharing-text").textContent = text;
  $("sharing-start").hidden = !(sharingActive() && watchId === null && !geoDenied);

  $("ghost-toggle").checked = locSettings.ghost;
  $("pause-buttons").hidden = locSettings.paused;
  $("pause-resume").hidden = !locSettings.paused;
  $("pause-text").textContent = locSettings.paused
    ? "Pausad " + pauseEndText() + ". Ingen position skickas och den sparade är raderad."
    : "Vännerna du har valt ser att du har pausat, men inte var du är.";

  renderViewerList();
}

function renderViewerList() {
  const chosen = new Set(locSettings.viewer_ids);
  const rows = locFriends.map(friend => {
    const li = document.createElement("li");
    const label = document.createElement("label");
    label.className = "switch-row viewer";
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    paintAvatar(avatar, friend.display_name, friend.avatar_color);
    const name = document.createElement("span");
    name.className = "viewer-name";
    name.textContent = friend.display_name;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "switch";
    input.checked = chosen.has(friend.user_id);
    input.setAttribute("aria-label", `${friend.display_name} får se min position`);
    input.addEventListener("change", () => setViewer(friend, input));
    label.append(avatar, name, input);
    li.appendChild(label);
    return li;
  });
  $("viewer-list").replaceChildren(...rows);
  $("viewer-empty").hidden = rows.length > 0;
}

function renderMap() {
  renderFriendMarkers(locUser ? friendsWithCurrentAge() : []);
  renderChip();
}

// ---------- Hämta från databasen ----------

async function loadSharing() {
  if (!sb || !locUser) return;
  const loadId = ++locLoadId;
  const [settingsRes, friendsRes] = await Promise.all([
    sb.rpc("get_my_location_settings"),
    sb.rpc("get_friend_locations"),
  ]);
  if (loadId !== locLoadId) return;

  const error = settingsRes.error || friendsRes.error;
  if (error) {
    if (locSettings) {
      // Tappad uppkoppling: behåll det vi har. Åldrarna fortsätter växa så att inget ser live ut.
      renderMap();
      return;
    }
    locSetupError = locationErrorText(error);
    renderSharing();
    return;
  }
  locSetupError = null;
  locSettings = settingsRes.data;
  locFriends = friendsRes.data || [];
  locFetchedAt = Date.now();
  schedulePauseEnd();
  updateWatch();
  renderSharing();
  renderMap();
}

// När en tidsbestämd paus tar slut startar delningen av sig själv.
function schedulePauseEnd() {
  clearTimeout(pauseTimer);
  if (!locSettings.paused || locSettings.paused_forever) return;
  const ms = new Date(locSettings.paused_until).getTime() - Date.now() + 2000;
  // setTimeout klarar inte längre än ~24 dagar, men en paus är högst 24 timmar.
  pauseTimer = setTimeout(loadSharing, Math.max(ms, 2000));
}

// ---------- GPS och skicka position ----------

async function geoPermission() {
  try {
    if (!navigator.permissions) return "unknown";
    return (await navigator.permissions.query({ name: "geolocation" })).state;
  } catch (e) {
    return "unknown"; // t.ex. äldre Safari
  }
}

// Startar eller stoppar GPS-bevakningen beroende på läget.
// userAction = true när du själv har tryckt, då får webbläsaren fråga om lov.
async function updateWatch(userAction = false) {
  const shouldRun = locUser && sharingActive() && document.visibilityState === "visible";
  if (!shouldRun) {
    stopWatch();
    return;
  }
  if (watchId !== null || !("geolocation" in navigator) || !window.isSecureContext) return;

  // Utan knapptryck startar vi bara om lov redan är givet, så att appen inte frågar oväntat.
  if (!userAction) {
    const state = await geoPermission();
    geoDenied = state === "denied";
    if (state !== "granted") {
      renderSharing();
      return;
    }
  }
  if (watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(onFix, onFixError, {
    enableHighAccuracy: true,
    timeout: 30000,
    maximumAge: 10000,
  });
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
  renderSharing();
}

function stopWatch() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  // Efter paus, osynligt läge eller när appen varit i bakgrunden ska nästa position skickas direkt,
  // och appen får inte visa "Live" utifrån ett gammalt skick.
  lastSent = null;
  lastSendResult = null;
}

function onFix(pos) {
  geoDenied = false;
  const { latitude, longitude, accuracy } = pos.coords;
  lastFix = { lat: latitude, lng: longitude, accuracy, time: pos.timestamp };
  showMe(latitude, longitude, accuracy, !locatedOnce && !startedAtMe && !userMovedMap);
  locatedOnce = true;
  maybeSend(false);
}

function onFixError(err) {
  if (err.code === 1) {
    geoDenied = true;
    stopWatch();
  }
  renderSharing();
}

// Står du still kommer det inga nya GPS-svar. Då frågar vi en gång i minuten,
// så att vännerna inte ser dig som inaktuell fast appen är öppen.
function heartbeat() {
  if (watchId === null) return;
  navigator.geolocation.getCurrentPosition(onFix, () => {}, {
    enableHighAccuracy: true,
    timeout: 20000,
    maximumAge: 30000,
  });
}

async function maybeSend(force) {
  if (!lastFix || sending || !sharingActive()) return;
  if (Date.now() - lastFix.time > MAX_FIX_AGE_MS || lastFix.accuracy > MAX_ACCURACY_M) return;
  if (!force && lastSent) {
    const sinceMs = Date.now() - lastSent.at;
    if (sinceMs < SEND_MIN_MS) return;
    if (sinceMs < HEARTBEAT_MS - 5000 && distanceMeters(lastSent, lastFix) < SEND_MIN_METERS) return;
  }

  sending = true;
  const fix = lastFix;
  sendPromise = sb.rpc("update_my_location", {
    p_lat: fix.lat,
    p_lng: fix.lng,
    p_accuracy: Math.round(fix.accuracy),
  });
  const { data, error } = await sendPromise;
  sendPromise = null;
  sending = false;
  if (!locSettings) return; // utloggad medan positionen skickades

  if (error) {
    lastSendResult = "error";
  } else {
    lastSendResult = data;
    if (data === "saved" || data === "too_soon") lastSent = { lat: fix.lat, lng: fix.lng, at: Date.now() };
    // Servern säger att du inte delar (t.ex. ändrat på en annan mobil): läs in läget igen.
    if (data === "paused" || data === "ghost" || data === "no_viewers") loadSharing();
  }
  renderSharing();
}

// Anropas av app.js när du trycker på positionsknappen. Returnerar true om positionen delas.
function onMyPosition(pos) {
  if (!locUser || !sharingActive()) return false;
  const { latitude, longitude, accuracy } = pos.coords;
  lastFix = { lat: latitude, lng: longitude, accuracy, time: pos.timestamp };
  locatedOnce = true;
  updateWatch(true);
  maybeSend(true);
  return true;
}

// ---------- Inställningar ----------

async function runSetting(fn, params, okText) {
  showMsg("sharing-msg", "");
  const { error } = await sb.rpc(fn, params);
  if (error) {
    showMsg("sharing-msg", locationErrorText(error));
  } else if (okText) {
    showMsg("sharing-msg", okText, "ok");
  }
  await loadSharing();
  return !error;
}

async function setViewer(friend, input) {
  input.disabled = true;
  const allowed = input.checked;
  const wasActive = sharingActive();
  const ok = await runSetting("set_location_viewer", { p_friend: friend.user_id, p_allowed: allowed },
    allowed ? `${friend.display_name} kan nu se din position medan du delar.` : `${friend.display_name} ser inte längre din position.`);
  input.disabled = false;
  // Första vännen du väljer är ett knapptryck, så då får appen fråga om platsåtkomst.
  if (ok && allowed && !wasActive) startNow();
}

async function toggleGhost() {
  const input = $("ghost-toggle");
  input.disabled = true;
  const on = input.checked;
  await runSetting("set_ghost_mode", { p_on: on },
    on ? "Osynligt läge är på. Din sparade position är raderad." : "Osynligt läge är av.");
  input.disabled = false;
  if (!on) startNow();
}

async function pause(minutes, btn) {
  setBusy(btn, true, "Pausar…");
  await runSetting("pause_location_sharing", { p_minutes: minutes }, "Delningen är pausad. Din sparade position är raderad.");
  setBusy(btn, false);
}

async function resume() {
  const btn = $("pause-resume");
  setBusy(btn, true, "Startar…");
  await runSetting("pause_location_sharing", { p_minutes: 0 }, "Delningen är igång igen.");
  setBusy(btn, false);
  startNow();
}

// Startar GPS:en direkt efter ett knapptryck (webbläsaren kan då fråga om lov).
function startNow() {
  if (!sharingActive()) return;
  geoDenied = false;
  updateWatch(true);
}

// Anropas av account.js innan utloggning, så att ingen gammal position ligger kvar.
async function clearLocationBeforeLogout() {
  // Stoppa allt som kan skicka en ny position under utloggningen.
  stopWatch();
  locLoadId++;
  clearInterval(pollTimer);
  clearTimeout(pauseTimer);
  locSettings = null;
  lastFix = null;
  if (!sb || !locUser) return;
  const clear = (async () => {
    // Ett skick som redan är på väg måste bli klart först, annars kan det återskapa positionen.
    if (sendPromise) await Promise.resolve(sendPromise).catch(() => {});
    await sb.rpc("clear_my_location");
  })();
  // Utan internet ska utloggningen ändå fungera, därför högst 3 sekunders väntan.
  await Promise.race([clear.catch(() => {}), new Promise(resolve => setTimeout(resolve, 3000))]);
}

// ---------- Start ----------

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    loadSharing();
    maybeSend(false);
  }, FRIENDS_POLL_MS);
}

function initLocation() {
  $("share-chip").addEventListener("click", () => {
    showView("profile");
    $("sharing").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("sharing-start").addEventListener("click", startNow);
  $("ghost-toggle").addEventListener("change", toggleGhost);
  $("pause-resume").addEventListener("click", resume);
  document.querySelectorAll("#pause-buttons button").forEach(btn => {
    btn.addEventListener("click", () => pause(btn.dataset.minutes === "forever" ? null : Number(btn.dataset.minutes), btn));
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      loadSharing();
    } else {
      // Webbläsaren slutar ändå ge positioner i bakgrunden. Stoppa så att inget halvt skickas.
      stopWatch();
      renderSharing();
    }
  });
  // Uppdatera "x min sedan" och live/grå även när inget nytt har hämtats.
  setInterval(() => {
    if (document.visibilityState === "visible" && locUser) renderMap();
  }, 15000);

  if (!sb) {
    renderSharing();
    return;
  }

  sb.auth.onAuthStateChange((event, session) => {
    const user = session ? session.user : null;
    const changed = event === "INITIAL_SESSION" || (user && user.id) !== (locUser && locUser.id);
    locUser = user;
    if (!changed) return;

    locLoadId++;
    stopWatch();
    clearTimeout(pauseTimer);
    locSettings = null;
    locFriends = [];
    lastFix = null;
    lastSent = null;
    lastSendResult = null;
    locSetupError = null;
    showMsg("sharing-msg", "");
    renderSharing();
    renderMap();
    if (!user) {
      clearInterval(pollTimer);
      return;
    }
    startPolling();
    // Samma råd som i account.js: anropa inte Supabase direkt inne i den här funktionen.
    setTimeout(loadSharing, 0);
  });
}

initLocation();
