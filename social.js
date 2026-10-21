// PULSE – etapp 6: statusar och aktiviteter (Supabase)
// ÄKTA: sätta och ta bort din status, se vännernas statusar, skapa aktiviteter, gå med, lämna och ställa in.
// Allt går via databasfunktionerna i supabase/etapp6-status-aktiviteter.sql. Appen kan inte läsa tabellerna direkt.
// Använder sb, $, showMsg, setBusy, paintAvatar, dbErrorText (account.js), showView, ageText (app.js)
// och renderMap (location.js) för att visa statusen på vännernas kartnålar.

const SOCIAL_POLL_MS = 30000; // hämta statusar och aktiviteter så här ofta medan appen syns

const STATUS_KINDS = {
  out:  { emoji: "🌆", label: "Ute" },
  home: { emoji: "🏠", label: "Hemma" },
  up:   { emoji: "🙌", label: "Vill hitta på något" },
};

let socialUser = null;
let socialLoadId = 0;
let socialTimer = null;
let socialLoaded = false;     // true när allt har hämtats minst en gång
let myStatus = null;          // svaret från get_my_status
let friendStatuses = [];      // svaret från get_friend_statuses
let activities = [];          // svaret från list_activities
let activitiesFetchedAt = 0;  // för att låta "om 20 min" räkna ner mellan hämtningarna

const HANG_BOXES = ["hang-loading", "hang-signed-out", "hang-setup", "hang-box"];

function showHangBox(id) {
  HANG_BOXES.forEach(box => { $(box).hidden = box !== id; });
  $("hang-refresh").hidden = id !== "hang-box";
}

function socialErrorText(error) {
  if (["PGRST202", "PGRST204", "42883", "42P01"].includes(error.code)) {
    return "Statusar och aktiviteter finns inte i databasen än. Kör filen supabase/etapp6-status-aktiviteter.sql i Supabase SQL Editor och tryck Försök igen.";
  }
  if (error.code === "42501") return "Saknar behörighet. Kör filen supabase/etapp6-status-aktiviteter.sql igen i Supabase.";
  const byMessage = {
    not_authenticated: "Du är utloggad. Logga in igen under Profil.",
    invalid_status: "Välj Ute, Hemma eller Vill hitta på något.",
    note_too_long: "Texten får vara högst 40 tecken.",
    invalid_duration: "Ogiltig tid för statusen.",
    invalid_title: "Skriv vad ni ska göra (1–60 tecken).",
    invalid_place: "Platsen får vara högst 60 tecken.",
    invalid_time: "Välj en tid från nu och högst 7 dagar fram.",
    too_many_activities: "Du kan ha högst 5 aktiviteter samtidigt. Ställ in någon först.",
    activity_not_found: "Aktiviteten finns inte längre. Listan har uppdaterats.",
    activity_full: "Aktiviteten är full (högst 50 deltagare).",
    creator_cannot_leave: "Du har skapat aktiviteten. Ställ in den i stället.",
  };
  return byMessage[error.message] || dbErrorText(error);
}

// Används av app.js för att visa status på vännernas kartnålar. Returnerar null om vännen inte har någon.
function friendStatusFor(userId) {
  const s = friendStatuses.find(f => f.user_id === userId);
  if (!s || !STATUS_KINDS[s.kind]) return null;
  return { ...STATUS_KINDS[s.kind], note: s.note };
}

// ---------- Tider ----------

function durationText(seconds) {
  const mins = Math.max(1, Math.ceil(seconds / 60));
  if (mins < 60) return mins + " min";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// Minuter kvar till midnatt (för "Resten av dagen"), minst 15 och högst 24 h.
function minutesToMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return Math.min(1440, Math.max(15, Math.floor((midnight - now) / 60000)));
}

// "Pågår nu", "Om 20 min", "Idag 19:00", "Imorgon 18:30", "Fre 12 nov 18:00"
function activityTimeText(activity) {
  const secs = activity.starts_in_seconds - Math.floor((Date.now() - activitiesFetchedAt) / 1000);
  if (secs <= 0) return "Pågår nu · började " + ageText(-secs);
  if (secs < 3600) return "Om " + Math.max(1, Math.round(secs / 60)) + " min";
  const start = new Date(activity.starts_at);
  const clock = start.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  if (start.toDateString() === today.toDateString()) return "Idag " + clock;
  if (start.toDateString() === tomorrow.toDateString()) return "Imorgon " + clock;
  return start.toLocaleDateString("sv-SE", { weekday: "short", day: "numeric", month: "short" }) + " " + clock;
}

// Värde för <input type="datetime-local"> i mobilens egen tid, t.ex. "2026-10-21T19:30".
function toLocalInputValue(date) {
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ---------- Visa ----------

function renderMyStatus() {
  const kind = myStatus && STATUS_KINDS[myStatus.kind];
  $("my-status-current").hidden = !kind;
  $("status-ghost-note").hidden = !(kind && myStatus.hidden_by_ghost);
  if (kind) {
    $("my-status-emoji").textContent = kind.emoji;
    $("my-status-label").textContent = kind.label;
    $("my-status-note").textContent = myStatus.note || "";
    $("my-status-note").hidden = !myStatus.note;
    $("my-status-expires").textContent = "Försvinner om " + durationText(myStatus.expires_in_seconds);
  }
  $("status-save").textContent = kind ? "Uppdatera status" : "Visa för mina vänner";
}

function smallAvatar(person, extraClass = "") {
  const el = document.createElement("div");
  el.className = "avatar " + extraClass;
  paintAvatar(el, person.display_name, person.avatar_color);
  return el;
}

function renderFriendStatuses() {
  const rows = friendStatuses.filter(s => STATUS_KINDS[s.kind]).map(s => {
    const kind = STATUS_KINDS[s.kind];
    const li = document.createElement("li");
    li.className = "friend";
    const info = document.createElement("div");
    info.className = "friend-info";
    const name = document.createElement("div");
    name.className = "friend-name";
    name.textContent = s.display_name;
    const line = document.createElement("div");
    line.className = "friend-status";
    line.textContent = `${kind.emoji} ${kind.label}` + (s.note ? ` · "${s.note}"` : "");
    info.append(name, line);
    const time = document.createElement("div");
    time.className = "friend-time";
    time.textContent = ageText(s.age_seconds);
    li.append(smallAvatar(s), info, time);
    return li;
  });
  $("friend-status-list").replaceChildren(...rows);
  $("friend-status-empty").hidden = rows.length > 0;
}

function renderActivities() {
  const cards = activities.map(a => {
    const li = document.createElement("li");
    li.className = "activity" + (a.i_joined ? " joined" : "");

    const head = document.createElement("div");
    head.className = "activity-head";
    const title = document.createElement("strong");
    title.className = "activity-title";
    title.textContent = a.title;
    const when = document.createElement("span");
    when.className = "activity-when";
    when.textContent = activityTimeText(a);
    head.append(title, when);

    const meta = document.createElement("div");
    meta.className = "muted activity-meta";
    meta.textContent = (a.is_mine ? "Du har skapat den" : "Av " + a.creator_name) + (a.place ? " · 📍 " + a.place : "");

    const members = document.createElement("div");
    members.className = "activity-members";
    const faces = document.createElement("div");
    faces.className = "faces";
    a.members.slice(0, 6).forEach(m => faces.appendChild(smallAvatar(m, "tiny")));
    const names = document.createElement("span");
    names.className = "muted";
    const n = a.members.length;
    names.textContent = n === 0 ? "Ingen har gått med än"
      : (n === 1 ? "1 går: " : n + " går: ") + a.members.map(m => m.display_name).join(", ");
    members.append(faces, names);

    const actions = document.createElement("div");
    actions.className = "friend-actions activity-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    if (a.is_mine) {
      btn.className = "small-btn danger";
      btn.textContent = "Ställ in";
      btn.addEventListener("click", () => activityAction(btn, "cancel_activity", a, {
        confirmText: `Ställa in "${a.title}"? Den försvinner för alla.`,
        busyText: "Ställer in…",
        okText: "Aktiviteten är inställd.",
      }));
    } else if (a.i_joined) {
      btn.className = "small-btn";
      btn.textContent = "Lämna";
      btn.addEventListener("click", () => activityAction(btn, "leave_activity", a, {
        busyText: "Lämnar…",
        okText: `Du har lämnat "${a.title}".`,
      }));
    } else {
      btn.className = "small-btn primary";
      btn.textContent = "Gå med";
      btn.addEventListener("click", () => activityAction(btn, "join_activity", a, {
        busyText: "Går med…",
        okText: `Du går med i "${a.title}" 🎉`,
      }));
    }
    actions.appendChild(btn);

    li.append(head, meta, members, actions);
    return li;
  });
  $("activity-list").replaceChildren(...cards);
  $("activity-empty").hidden = cards.length > 0;

  // Antal aktiviteter från vänner som du inte har gått med i, som en liten siffra på Häng-fliken.
  const open = activities.filter(a => !a.is_mine && !a.i_joined).length;
  const badge = $("hang-badge");
  badge.textContent = open > 9 ? "9+" : String(open);
  badge.hidden = open === 0;
}

function renderHang() {
  renderMyStatus();
  renderFriendStatuses();
  renderActivities();
}

// ---------- Hämta från databasen ----------

async function loadSocial() {
  if (!sb || !socialUser) return;
  const loadId = ++socialLoadId;
  const [mineRes, friendsRes, actRes] = await Promise.all([
    sb.rpc("get_my_status"),
    sb.rpc("get_friend_statuses"),
    sb.rpc("list_activities"),
  ]);
  if (loadId !== socialLoadId) return;

  const error = mineRes.error || friendsRes.error || actRes.error;
  if (error) {
    // Gick det bra förut (t.ex. tappad uppkoppling) behåller vi det vi har och visar bara felet.
    if (socialLoaded) {
      showMsg("hang-msg", socialErrorText(error));
      return;
    }
    $("hang-setup-text").textContent = socialErrorText(error);
    showHangBox("hang-setup");
    return;
  }
  socialLoaded = true;
  myStatus = mineRes.data;
  friendStatuses = friendsRes.data || [];
  activities = (actRes.data || []).map(a => ({ ...a, members: Array.isArray(a.members) ? a.members : [] }));
  activitiesFetchedAt = Date.now();
  renderHang();
  showHangBox("hang-box");
  // Kartnålarna visar vännernas status (location.js ritar om dem).
  if (typeof renderMap === "function") renderMap();
}

// ---------- Status ----------

async function saveStatus(event) {
  event.preventDefault();
  showMsg("hang-msg", "");
  const kind = document.querySelector('input[name="status-kind"]:checked');
  if (!kind) {
    showMsg("hang-msg", "Välj Ute, Hemma eller Vill hitta på något.");
    return;
  }
  const durationValue = document.querySelector('input[name="status-duration"]:checked').value;
  const minutes = durationValue === "day" ? minutesToMidnight() : Number(durationValue);
  const btn = $("status-save");
  setBusy(btn, true, "Sparar…");
  const { error } = await sb.rpc("set_my_status", {
    p_kind: kind.value,
    p_note: $("status-note").value.trim() || null,
    p_minutes: minutes,
  });
  setBusy(btn, false);
  if (error) {
    showMsg("hang-msg", socialErrorText(error));
  } else {
    showMsg("hang-msg", "Din status syns nu för dina vänner ✓", "ok");
    $("status-note").value = "";
    kind.checked = false;
  }
  loadSocial();
}

async function clearStatus() {
  const btn = $("status-clear");
  setBusy(btn, true, "Tar bort…");
  const { error } = await sb.rpc("clear_my_status");
  setBusy(btn, false);
  showMsg("hang-msg", error ? socialErrorText(error) : "Din status är borttagen.", error ? "error" : "ok");
  loadSocial();
}

// ---------- Aktiviteter ----------

function openActivityForm() {
  // Förslag: om en halvtimme, avrundat uppåt till närmaste kvart.
  const start = new Date(Date.now() + 30 * 60000);
  start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
  $("activity-time").value = toLocalInputValue(start);
  $("activity-time").min = toLocalInputValue(new Date());
  $("activity-time").max = toLocalInputValue(new Date(Date.now() + 7 * 24 * 3600 * 1000));
  $("activity-form").hidden = false;
  $("activity-new").hidden = true;
  $("activity-title").focus();
}

function closeActivityForm() {
  $("activity-form").reset();
  $("activity-form").hidden = true;
  $("activity-new").hidden = false;
}

async function createActivity(event) {
  event.preventDefault();
  showMsg("hang-msg", "");
  const title = $("activity-title").value.trim();
  const start = new Date($("activity-time").value);
  if (!title) {
    showMsg("hang-msg", "Skriv vad ni ska göra.");
    return;
  }
  if (Number.isNaN(start.getTime())) {
    showMsg("hang-msg", "Välj dag och tid.");
    return;
  }
  // Har man valt en tid som just passerat (t.ex. "nu") räknas det som nu.
  const startsAt = start.getTime() < Date.now() ? new Date() : start;
  const btn = $("activity-submit");
  setBusy(btn, true, "Skapar…");
  const { error } = await sb.rpc("create_activity", {
    p_title: title,
    p_place: $("activity-place").value.trim() || null,
    p_starts_at: startsAt.toISOString(),
  });
  setBusy(btn, false);
  if (error) {
    showMsg("hang-msg", socialErrorText(error));
    return;
  }
  closeActivityForm();
  showMsg("hang-msg", "Aktiviteten är skapad. Dina vänner ser den nu 🎉", "ok");
  loadSocial();
}

async function activityAction(btn, fn, activity, { confirmText, busyText, okText }) {
  if (confirmText && !window.confirm(confirmText)) return;
  showMsg("hang-msg", "");
  setBusy(btn, true, busyText);
  const { error } = await sb.rpc(fn, { p_activity: activity.id });
  setBusy(btn, false);
  showMsg("hang-msg", error ? socialErrorText(error) : okText, error ? "error" : "ok");
  loadSocial();
}

// ---------- Start ----------

function startSocialTimer() {
  clearInterval(socialTimer);
  socialTimer = setInterval(() => {
    if (document.visibilityState === "visible") loadSocial();
  }, SOCIAL_POLL_MS);
}

function initSocial() {
  $("hang-go-profile").addEventListener("click", () => showView("profile"));
  $("hang-retry").addEventListener("click", loadSocial);
  $("hang-refresh").addEventListener("click", () => {
    showMsg("hang-msg", "");
    loadSocial();
  });
  $("status-form").addEventListener("submit", saveStatus);
  $("status-clear").addEventListener("click", clearStatus);
  $("activity-new").addEventListener("click", openActivityForm);
  $("activity-cancel-form").addEventListener("click", closeActivityForm);
  $("activity-form").addEventListener("submit", createActivity);
  document.querySelector('.nav-btn[data-view="hang"]').addEventListener("click", loadSocial);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadSocial();
  });
  // Låt "om 20 min" och "försvinner om" räkna ner även mellan hämtningarna.
  setInterval(() => {
    if (document.visibilityState === "visible" && socialLoaded) renderActivities();
  }, 15000);

  if (!sb) {
    // account.js har redan förklarat felet under Profil.
    $("hang-setup-text").textContent = "Konton är inte påslagna. Se Profil-fliken.";
    $("hang-retry").hidden = true;
    showHangBox("hang-setup");
    return;
  }

  sb.auth.onAuthStateChange((event, session) => {
    const user = session ? session.user : null;
    const changed = event === "INITIAL_SESSION" || (user && user.id) !== (socialUser && socialUser.id);
    socialUser = user;
    if (!changed) return;

    socialLoadId++;
    socialLoaded = false;
    myStatus = null;
    friendStatuses = [];
    activities = [];
    showMsg("hang-msg", "");
    closeActivityForm();
    $("hang-badge").hidden = true;
    if (typeof renderMap === "function") renderMap();
    if (!user) {
      clearInterval(socialTimer);
      showHangBox("hang-signed-out");
      return;
    }
    showHangBox("hang-loading");
    startSocialTimer();
    // Samma råd som i account.js: anropa inte Supabase direkt inne i den här funktionen.
    setTimeout(loadSocial, 0);
  });
}

initSocial();
