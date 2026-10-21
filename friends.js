// PULSE – etapp 4: vänner (Supabase)
// ÄKTA: vänkod, vänförfrågningar, acceptera/avvisa, ångra, ta bort vän, blockera och häva blockering.
// Allt går via databasfunktionerna i supabase/etapp4-vanner.sql. Appen kan inte läsa vän-tabellerna direkt.
// Använder sb, $, showMsg, setBusy, paintAvatar, dbErrorText och appUrl från account.js.

const FRIENDS_REFRESH_MS = 60000; // hämta nya förfrågningar varje minut medan appen är öppen

let friendsUser = null;    // inloggad användare enligt den här filen
let friendsLoadId = 0;     // så att ett gammalt svar inte skriver över ett nyare
let friendsTimer = null;
let pendingAddCode = null; // kod från en delad länk (?add=KOD)

const FRIENDS_BOXES = ["friends-loading", "friends-signed-out", "friends-setup", "friends-box"];

function showFriendsBox(id) {
  FRIENDS_BOXES.forEach(box => { $(box).hidden = box !== id; });
  $("friends-refresh").hidden = id !== "friends-box";
}

function formatFriendCode(code) {
  return code ? code.slice(0, 4) + "-" + code.slice(4) : "····-····";
}

function normalizeFriendCode(text) {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function shortDate(iso) {
  return new Date(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" });
}

function friendsErrorText(error) {
  const missing = "Vänfunktionerna finns inte i databasen än. Kör filen supabase/etapp4-vanner.sql i Supabase SQL Editor och tryck Försök igen.";
  // PGRST202 = funktionen saknas, 42703 = kolumnen friend_code saknas.
  if (["PGRST202", "PGRST204", "42883", "42703"].includes(error.code)) return missing;
  if (error.code === "42501") return "Saknar behörighet. Kör filen supabase/etapp4-vanner.sql igen i Supabase.";
  const byMessage = {
    request_not_found: "Förfrågan finns inte längre. Listan har uppdaterats.",
    cannot_block_self: "Du kan inte blockera dig själv.",
    user_not_found: "Personen finns inte längre.",
    not_authenticated: "Du är utloggad. Logga in igen under Profil.",
  };
  return byMessage[error.message] || dbErrorText(error);
}

// ---------- Listor ----------

// Bygger en rad med avatar, namn och knappar. actions = [{ label, kind, onClick }]
function personRow(person, subtitle, actions, collapsed = false) {
  const li = document.createElement("li");
  li.className = "person";

  const row = document.createElement("div");
  row.className = "friend";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  paintAvatar(avatar, person.display_name, person.avatar_color);

  const info = document.createElement("div");
  info.className = "friend-info";
  const name = document.createElement("div");
  name.className = "friend-name";
  name.textContent = person.display_name;
  const sub = document.createElement("div");
  sub.className = "friend-status";
  sub.textContent = (person.username ? "@" + person.username + " · " : "") + subtitle;
  info.append(name, sub);
  row.append(avatar, info);

  const bar = document.createElement("div");
  bar.className = "friend-actions";
  actions.forEach(action => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "small-btn " + (action.kind || "");
    btn.textContent = action.label;
    btn.addEventListener("click", () => action.onClick(btn));
    bar.appendChild(btn);
  });

  if (collapsed) {
    // Vänners knappar göms bakom ⋯ så att man inte råkar ta bort någon.
    const more = document.createElement("button");
    more.type = "button";
    more.className = "icon-btn";
    more.textContent = "⋯";
    more.setAttribute("aria-label", "Val för " + person.display_name);
    more.setAttribute("aria-expanded", "false");
    bar.hidden = true;
    more.addEventListener("click", () => {
      bar.hidden = !bar.hidden;
      more.setAttribute("aria-expanded", String(!bar.hidden));
    });
    row.appendChild(more);
  }

  li.append(row, bar);
  return li;
}

function fillList(listId, sectionId, rows) {
  const list = $(listId);
  list.replaceChildren(...rows);
  if (sectionId) $(sectionId).hidden = rows.length === 0;
}

// Kör en databasfunktion från en knapp och laddar om listorna efteråt.
async function friendAction(btn, fn, params, { confirmText, busyText = "Vänta…", okText } = {}) {
  if (confirmText && !window.confirm(confirmText)) return;
  setBusy(btn, true, busyText);
  const { error } = await sb.rpc(fn, params);
  setBusy(btn, false);
  if (error) {
    showMsg("friends-msg", friendsErrorText(error));
  } else {
    showMsg("friends-msg", okText || "", "ok");
  }
  loadFriends();
}

function blockAction(person) {
  return {
    label: "Blockera",
    kind: "danger",
    onClick: btn => friendAction(btn, "block_user", { p_user: person.user_id }, {
      confirmText: `Blockera ${person.display_name}? Ni slutar vara vänner och hen kan inte skicka nya förfrågningar till dig. Hen får inget meddelande.`,
      busyText: "Blockerar…",
      okText: `${person.display_name} är blockerad.`,
    }),
  };
}

function renderFriends(code, friends, requests, blocked) {
  $("my-friend-code").textContent = formatFriendCode(code);
  $("my-friend-code").dataset.code = code;

  const incoming = requests.filter(r => r.direction === "incoming");
  const outgoing = requests.filter(r => r.direction === "outgoing");

  fillList("incoming-list", "incoming-section", incoming.map(p => personRow(p, "vill bli din vän · " + shortDate(p.created_at), [
    { label: "Acceptera", kind: "primary", onClick: btn => friendAction(btn, "respond_to_friend_request", { p_sender: p.user_id, p_accept: true }, { okText: `Du och ${p.display_name} är nu vänner 🎉` }) },
    { label: "Avvisa", onClick: btn => friendAction(btn, "respond_to_friend_request", { p_sender: p.user_id, p_accept: false }, { okText: "Förfrågan avvisad." }) },
    blockAction(p),
  ])));

  fillList("friends-list", null, friends.map(p => personRow(p, "vänner sedan " + shortDate(p.friends_since), [
    {
      label: "Ta bort vän",
      onClick: btn => friendAction(btn, "remove_friend", { p_friend: p.user_id }, {
        confirmText: `Ta bort ${p.display_name} som vän? Hen får inget meddelande.`,
        busyText: "Tar bort…",
        okText: `${p.display_name} är borttagen.`,
      }),
    },
    blockAction(p),
  ], true)));
  $("friends-count").textContent = friends.length ? `(${friends.length})` : "";
  $("friends-empty").hidden = friends.length > 0;

  fillList("outgoing-list", "outgoing-section", outgoing.map(p => personRow(p, "väntar på svar · " + shortDate(p.created_at), [
    { label: "Ångra", onClick: btn => friendAction(btn, "cancel_friend_request", { p_receiver: p.user_id }, { okText: "Förfrågan ångrad." }) },
  ])));

  fillList("blocked-list", "blocked-section", blocked.map(p => personRow(p, "blockerad " + shortDate(p.blocked_at), [
    { label: "Häv blockering", onClick: btn => friendAction(btn, "unblock_user", { p_user: p.user_id }, { okText: `Blockeringen av ${p.display_name} är hävd.` }) },
  ])));
  $("blocked-count").textContent = `(${blocked.length})`;

  const badge = $("friends-badge");
  badge.textContent = incoming.length > 9 ? "9+" : String(incoming.length);
  badge.hidden = incoming.length === 0;
}

async function loadFriends() {
  if (!sb || !friendsUser) return;
  const loadId = ++friendsLoadId;
  const user = friendsUser;
  if ($("friends-box").hidden) showFriendsBox("friends-loading");

  const [codeRes, friendsRes, requestsRes, blockedRes] = await Promise.all([
    sb.from("profiles").select("friend_code").eq("id", user.id).maybeSingle(),
    sb.rpc("list_friends"),
    sb.rpc("list_friend_requests"),
    sb.rpc("list_blocked"),
  ]);
  if (loadId !== friendsLoadId) return;

  const error = codeRes.error || friendsRes.error || requestsRes.error || blockedRes.error;
  if (error || !codeRes.data || !codeRes.data.friend_code) {
    // Gick det bra förut (t.ex. tappad uppkoppling) behåller vi listan och visar bara felet.
    if (error && !$("friends-box").hidden) {
      showMsg("friends-msg", friendsErrorText(error));
      return;
    }
    $("friends-setup-text").textContent = error
      ? friendsErrorText(error)
      : "Din profil saknar vänkod. Kör filen supabase/etapp4-vanner.sql i Supabase SQL Editor och tryck Försök igen.";
    showFriendsBox("friends-setup");
    $("friends-badge").hidden = true;
    return;
  }

  renderFriends(codeRes.data.friend_code, friendsRes.data || [], requestsRes.data || [], blockedRes.data || []);
  showFriendsBox("friends-box");
  usePendingAddCode();
}

// ---------- Lägg till vän ----------

const SEND_RESULTS = {
  sent: name => [`Förfrågan skickad till ${name}. Ni blir vänner när hen accepterar.`, "ok"],
  now_friends: name => [`${name} hade redan skickat en förfrågan till dig. Nu är ni vänner 🎉`, "ok"],
  already_sent: name => [`Du har redan skickat en förfrågan till ${name}.`, "ok"],
  already_friends: name => [`Du och ${name} är redan vänner.`, "ok"],
  self: () => ["Det där är din egen kod 😄 Be din vän om hens kod.", "error"],
  not_found: () => ["Ingen användare hittades med den koden. Kontrollera stavningen.", "error"],
  you_blocked: () => ["Du har blockerat den personen. Häv blockeringen under Blockerade först.", "error"],
  too_many_pending: () => ["Du har för många obesvarade förfrågningar. Ångra några först.", "error"],
  rate_limited: () => ["Du har provat många koder på kort tid. Vänta en stund och försök igen.", "error"],
};

async function addFriend(event) {
  event.preventDefault();
  const code = normalizeFriendCode($("add-friend-code").value);
  showMsg("add-friend-msg", "");
  if (code.length !== 8) {
    showMsg("add-friend-msg", "En vänkod har 8 tecken, t.ex. K7QM-3XPA.");
    return;
  }
  if (code === $("my-friend-code").dataset.code) {
    showMsg("add-friend-msg", ...SEND_RESULTS.self());
    return;
  }

  const btn = $("add-friend-submit");
  setBusy(btn, true, "Skickar…");
  const { data, error } = await sb.rpc("send_friend_request", { p_code: code });
  setBusy(btn, false);
  if (error) {
    showMsg("add-friend-msg", friendsErrorText(error));
    return;
  }
  const result = SEND_RESULTS[data && data.result];
  const [text, kind] = result ? result(data.display_name) : ["Något gick fel. Försök igen.", "error"];
  showMsg("add-friend-msg", text, kind);
  if (kind === "ok") $("add-friend-code").value = "";
  loadFriends();
}

// ---------- Min vänkod ----------

function shareText() {
  const code = $("my-friend-code").dataset.code;
  return `Lägg till mig på PULSE! Min vänkod är ${formatFriendCode(code)}`;
}

function shareLink() {
  return appUrl() + "?add=" + encodeURIComponent($("my-friend-code").dataset.code);
}

async function copyCode() {
  const btn = $("code-copy");
  const code = formatFriendCode($("my-friend-code").dataset.code);
  try {
    await navigator.clipboard.writeText(code);
    btn.textContent = "Kopierad ✓";
  } catch (e) {
    // Vissa webbläsare tillåter inte kopiering. Markera koden så att man kan kopiera den själv.
    const range = document.createRange();
    range.selectNodeContents($("my-friend-code"));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    btn.textContent = "Håll in koden för att kopiera";
  }
  setTimeout(() => { btn.textContent = "Kopiera"; }, 2500);
}

async function shareCode() {
  try {
    await navigator.share({ title: "PULSE", text: shareText(), url: shareLink() });
  } catch (e) {
    // Avbrutet av användaren eller inte tillåtet. Inget att göra.
  }
}

async function newCode() {
  const ok = window.confirm("Byta till en ny vänkod? Den gamla slutar fungera direkt. Dina vänner och förfrågningar finns kvar.");
  if (!ok) return;
  const btn = $("code-new");
  setBusy(btn, true, "Byter…");
  const { error } = await sb.rpc("regenerate_friend_code");
  setBusy(btn, false);
  showMsg("friends-msg", error ? friendsErrorText(error) : "Du har en ny vänkod ✓", error ? "error" : "ok");
  loadFriends();
}

// ---------- Delad länk: ?add=KOD ----------

function readAddLink() {
  const params = new URLSearchParams(location.search);
  const code = normalizeFriendCode(params.get("add") || "");
  if (!params.has("add")) return;
  params.delete("add");
  const rest = params.toString();
  history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
  if (code.length === 8) {
    pendingAddCode = code;
    showView("friends");
  }
}

// Fyller i koden från länken. Förfrågan skickas först när du själv trycker på knappen.
function usePendingAddCode() {
  if (!pendingAddCode) return;
  $("add-friend-code").value = formatFriendCode(pendingAddCode);
  showMsg("add-friend-msg", "Koden kommer från en delad länk. Tryck Skicka förfrågan om du vill bli vän med personen.", "ok");
  pendingAddCode = null;
}

// ---------- Start ----------

function startFriendsTimer() {
  clearInterval(friendsTimer);
  friendsTimer = setInterval(() => {
    if (document.visibilityState === "visible") loadFriends();
  }, FRIENDS_REFRESH_MS);
}

function initFriends() {
  readAddLink();
  $("friends-go-profile").addEventListener("click", () => showView("profile"));
  $("friends-retry").addEventListener("click", loadFriends);
  $("friends-refresh").addEventListener("click", () => {
    showMsg("friends-msg", "");
    loadFriends();
  });
  $("add-friend-form").addEventListener("submit", addFriend);
  $("code-copy").addEventListener("click", copyCode);
  $("code-new").addEventListener("click", newCode);
  if (navigator.share) {
    $("code-share").hidden = false;
    $("code-share").addEventListener("click", shareCode);
  }
  document.querySelector('.nav-btn[data-view="friends"]').addEventListener("click", loadFriends);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadFriends();
  });

  if (!sb) {
    // account.js har redan förklarat felet under Profil.
    $("friends-setup-text").textContent = "Konton är inte påslagna. Se Profil-fliken.";
    $("friends-retry").hidden = true;
    showFriendsBox("friends-setup");
    return;
  }

  sb.auth.onAuthStateChange((event, session) => {
    const user = session ? session.user : null;
    const changed = event === "INITIAL_SESSION" || (user && user.id) !== (friendsUser && friendsUser.id);
    friendsUser = user;
    if (!changed) return;

    friendsLoadId++;
    showMsg("friends-msg", "");
    showMsg("add-friend-msg", "");
    $("friends-badge").hidden = true;
    if (!user) {
      clearInterval(friendsTimer);
      showFriendsBox("friends-signed-out");
      return;
    }
    showFriendsBox("friends-loading");
    startFriendsTimer();
    // Samma råd som i account.js: anropa inte Supabase direkt inne i den här funktionen.
    setTimeout(loadFriends, 0);
  });
}

initFriends();
