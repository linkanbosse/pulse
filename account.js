// PULSE – etapp 3: konton och profiler (Supabase)
// ÄKTA: registrering, inloggning, utloggning, glömt lösenord, profil och radering av konto.
// Inställningarna (Supabase-adress och publik nyckel) ligger i config.js.

// Samma namn som i databasens regel (supabase/etapp3-profiler.sql).
const AVATAR_COLORS = {
  violet: ["#7c5cff", "#2bb5ff"],
  pink:   ["#ff4fd8", "#7c5cff"],
  orange: ["#ff7a59", "#ff4fd8"],
  green:  ["#3ee08f", "#2bb5ff"],
  blue:   ["#2bb5ff", "#3ee0d0"],
  yellow: ["#ffcc4d", "#ff7a59"],
};
const USERNAME_RULE = /^[a-z0-9_]{3,20}$/;

let sb = null;              // Supabase-klienten
let currentUser = null;     // inloggad användare, eller null
let currentProfile = null;  // raden i tabellen profiles
let recoveryMode = false;   // true när du kommit hit via "glömt lösenord"-mejlet
let signupMode = false;     // flikarna "Logga in" / "Skapa konto"
let profileLoadId = 0;      // så att ett gammalt svar inte skriver över ett nyare

const $ = id => document.getElementById(id);

// ---------- Visa rätt ruta ----------

const ACCOUNT_BOXES = ["account-loading", "account-setup", "auth-box", "recovery-box", "profile-box"];

function showAccountBox(id) {
  ACCOUNT_BOXES.forEach(box => { $(box).hidden = box !== id; });
}

function showMsg(id, text, kind = "error") {
  const el = $(id);
  el.textContent = text;
  el.className = "msg " + kind;
  el.hidden = !text;
}

function setBusy(button, busy, busyText) {
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyText;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
  button.disabled = busy;
}

function render() {
  if (!sb) return;
  if (recoveryMode && currentUser) {
    showAccountBox("recovery-box");
  } else if (!currentUser) {
    showAccountBox("auth-box");
  } else if (!currentProfile) {
    showAccountBox("account-loading");
  } else {
    renderProfile();
    showAccountBox("profile-box");
  }
}

// ---------- Inställningar ----------

function decodeJwtRole(key) {
  try {
    const part = key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part + "===".slice((part.length + 3) % 4))).role;
  } catch (e) {
    return null;
  }
}

// Returnerar en förklaring om något är fel i config.js, annars null.
function configProblem(cfg) {
  if (typeof supabase === "undefined") {
    return "Inloggningsdelen kunde inte laddas. Kontrollera internet och ladda om sidan.";
  }
  if (!cfg || !cfg.supabaseUrl || !cfg.supabaseKey) {
    return "Supabase-adressen och den publika nyckeln är inte inlagda i config.js än. Resten av appen fungerar som vanligt.";
  }
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(cfg.supabaseUrl.trim())) {
    return "supabaseUrl i config.js ser fel ut. Den ska se ut som https://abcdefgh.supabase.co";
  }
  const key = cfg.supabaseKey.trim();
  if (key.startsWith("sb_secret_") || (key.split(".").length === 3 && decodeJwtRole(key) !== "anon")) {
    return "STOPP: nyckeln i config.js är en hemlig nyckel. Ta bort den direkt, använd den publika (sb_publishable_ eller anon) och skapa en ny hemlig nyckel i Supabase.";
  }
  if (!key.startsWith("sb_publishable_") && key.split(".").length !== 3) {
    return "supabaseKey i config.js ser fel ut. Använd \"Publishable key\" (börjar med sb_publishable_).";
  }
  return null;
}

// ---------- Felmeddelanden på svenska ----------

function authErrorText(error) {
  const byCode = {
    invalid_credentials: "Fel e-post eller lösenord.",
    email_not_confirmed: "Du behöver först bekräfta din e-post. Kolla inkorgen (och skräpposten).",
    user_already_exists: "Det finns redan ett konto med den e-posten. Logga in i stället.",
    email_exists: "Det finns redan ett konto med den e-posten. Logga in i stället.",
    weak_password: "Lösenordet är för svagt. Välj ett längre lösenord.",
    same_password: "Det nya lösenordet måste skilja sig från det gamla.",
    email_address_invalid: "E-postadressen ser inte giltig ut.",
    over_email_send_rate_limit: "Supabase gratis kan bara skicka 2 mejl i timmen. Vänta en stund och försök igen.",
    over_request_rate_limit: "För många försök. Vänta några minuter och försök igen.",
    signup_disabled: "Nya konton är avstängda i Supabase just nu.",
    session_not_found: "Du är utloggad. Logga in igen.",
  };
  if (error && byCode[error.code]) return byCode[error.code];
  if (error && (error.name === "AuthRetryableFetchError" || error.status === 0 || /fetch|network/i.test(error.message || ""))) {
    return "Ingen kontakt med servern. Kontrollera internet. (Gratisprojekt i Supabase pausas efter en veckas inaktivitet och måste då startas igen i Supabase.)";
  }
  return "Något gick fel: " + ((error && error.message) || "okänt fel");
}

function dbErrorText(error) {
  if (error.code === "23505") return "Användarnamnet är upptaget. Välj ett annat.";
  if (error.code === "23514") return "Något av fälten är inte tillåtet. Kontrollera namn och användarnamn.";
  if (error.code === "PGRST205" || error.code === "42P01") {
    return "Tabellen profiles finns inte. Kör filen supabase/etapp3-profiler.sql i Supabase SQL Editor.";
  }
  if (error.code === "42501") return "Saknar behörighet. Kör filen supabase/etapp3-profiler.sql igen i Supabase.";
  return authErrorText(error);
}

// ---------- Profil ----------

function paintAvatar(el, name, color) {
  const [c1, c2] = AVATAR_COLORS[color] || AVATAR_COLORS.violet;
  el.style.setProperty("--c1", c1);
  el.style.setProperty("--c2", c2);
  el.textContent = (name || "?").trim().slice(0, 1).toUpperCase() || "?";
}

function renderProfile() {
  const p = currentProfile;
  paintAvatar($("profile-avatar"), p.display_name, p.avatar_color);
  $("profile-name").textContent = p.display_name;
  $("profile-username").textContent = p.username ? "@" + p.username : "Inget användarnamn än";
  $("profile-email").textContent = currentUser.email || "";
}

function fillProfileForm() {
  const p = currentProfile;
  $("profile-display-name").value = p.display_name;
  $("profile-handle").value = p.username || "";
  const radio = document.querySelector(`input[name="avatar-color"][value="${p.avatar_color}"]`);
  if (radio) radio.checked = true;
}

function buildColorChoices() {
  const box = $("color-choices");
  Object.entries(AVATAR_COLORS).forEach(([name, [c1, c2]]) => {
    const label = document.createElement("label");
    label.className = "color-choice";
    label.style.setProperty("--c1", c1);
    label.style.setProperty("--c2", c2);
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "avatar-color";
    input.value = name;
    input.setAttribute("aria-label", name);
    input.addEventListener("change", () => {
      paintAvatar($("profile-avatar"), $("profile-display-name").value || currentProfile.display_name, name);
    });
    label.appendChild(input);
    box.appendChild(label);
  });
}

async function loadProfile(user) {
  const loadId = ++profileLoadId;
  const columns = "id, display_name, username, avatar_color";
  let { data, error } = await sb.from("profiles").select(columns).eq("id", user.id).maybeSingle();

  // Profilen skapas av databasen vid registrering. Saknas den ändå (t.ex. om SQL-filen kördes senare) skapar vi den här.
  if (!error && !data) {
    const name = ((user.user_metadata && user.user_metadata.display_name) || "").trim().slice(0, 30) || "Ny användare";
    ({ data, error } = await sb.from("profiles").insert({ id: user.id, display_name: name }).select(columns).single());
  }
  if (loadId !== profileLoadId) return;

  if (error) {
    $("account-setup-text").textContent = dbErrorText(error);
    $("account-retry").hidden = false;
    showAccountBox("account-setup");
    return;
  }
  currentProfile = data;
  fillProfileForm();
  render();
}

async function saveProfile(event) {
  event.preventDefault();
  const displayName = $("profile-display-name").value.trim();
  const username = $("profile-handle").value.trim().toLowerCase();
  const checked = document.querySelector('input[name="avatar-color"]:checked');
  const color = checked ? checked.value : currentProfile.avatar_color;
  showMsg("profile-msg", "");

  if (displayName.length < 1 || displayName.length > 30) {
    showMsg("profile-msg", "Visningsnamnet ska vara 1–30 tecken.");
    return;
  }
  if (username && !USERNAME_RULE.test(username)) {
    showMsg("profile-msg", "Användarnamnet ska vara 3–20 tecken och bara innehålla a–z, 0–9 och _.");
    return;
  }

  const btn = $("profile-save");
  setBusy(btn, true, "Sparar…");
  const { data, error } = await sb
    .from("profiles")
    .update({ display_name: displayName, username: username || null, avatar_color: color })
    .eq("id", currentUser.id)
    .select("id, display_name, username, avatar_color")
    .single();
  setBusy(btn, false);

  if (error) {
    showMsg("profile-msg", dbErrorText(error));
    return;
  }
  currentProfile = data;
  renderProfile();
  fillProfileForm();
  showMsg("profile-msg", "Sparat ✓", "ok");
}

// ---------- Inloggning och registrering ----------

function setSignupMode(on) {
  signupMode = on;
  $("tab-login").classList.toggle("active", !on);
  $("tab-signup").classList.toggle("active", on);
  $("tab-login").setAttribute("aria-selected", String(!on));
  $("tab-signup").setAttribute("aria-selected", String(on));
  $("signup-name-row").hidden = !on;
  $("auth-name").required = on;
  $("auth-password").autocomplete = on ? "new-password" : "current-password";
  $("auth-submit").textContent = on ? "Skapa konto" : "Logga in";
  $("forgot-btn").hidden = on;
  showMsg("auth-msg", "");
}

// Hit skickas man tillbaka från mejlen (bekräftelse och nytt lösenord).
function appUrl() {
  return location.origin + location.pathname;
}

async function submitAuth(event) {
  event.preventDefault();
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  const btn = $("auth-submit");
  showMsg("auth-msg", "");

  if (signupMode) {
    const name = $("auth-name").value.trim();
    if (!name) {
      showMsg("auth-msg", "Skriv ditt namn.");
      return;
    }
    setBusy(btn, true, "Skapar konto…");
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { data: { display_name: name }, emailRedirectTo: appUrl() },
    });
    setBusy(btn, false);
    if (error) {
      showMsg("auth-msg", authErrorText(error));
      return;
    }
    if (!data.session) {
      // E-postbekräftelse är påslagen i Supabase. Av integritetsskäl säger Supabase inte om adressen redan har ett konto.
      showMsg("auth-msg", "Nästan klart! Om adressen inte redan har ett konto har vi skickat ett mejl. Tryck på länken i mejlet och logga sedan in här.", "ok");
    }
    // Annars loggas du in direkt och onAuthStateChange visar profilen.
    return;
  }

  setBusy(btn, true, "Loggar in…");
  const { error } = await sb.auth.signInWithPassword({ email, password });
  setBusy(btn, false);
  if (error) showMsg("auth-msg", authErrorText(error));
}

async function forgotPassword() {
  const email = $("auth-email").value.trim();
  if (!$("auth-email").checkValidity() || !email) {
    showMsg("auth-msg", "Skriv din e-post i fältet ovan först, tryck sedan på Glömt lösenordet igen.");
    $("auth-email").focus();
    return;
  }
  const btn = $("forgot-btn");
  setBusy(btn, true, "Skickar…");
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
  setBusy(btn, false);
  if (error) {
    showMsg("auth-msg", authErrorText(error));
    return;
  }
  showMsg("auth-msg", "Om det finns ett konto med den adressen har vi skickat en länk för att välja nytt lösenord. Öppna den på den här mobilen.", "ok");
}

async function submitNewPassword(event) {
  event.preventDefault();
  const btn = $("recovery-submit");
  setBusy(btn, true, "Sparar…");
  const { error } = await sb.auth.updateUser({ password: $("recovery-password").value });
  setBusy(btn, false);
  if (error) {
    showMsg("recovery-msg", authErrorText(error));
    return;
  }
  recoveryMode = false;
  $("recovery-password").value = "";
  render();
  showMsg("profile-msg", "Nytt lösenord sparat ✓", "ok");
}

async function logout() {
  const btn = $("logout-btn");
  setBusy(btn, true, "Loggar ut…");
  // "local" loggar ut den här mobilen även utan internet.
  await sb.auth.signOut({ scope: "local" });
  setBusy(btn, false);
}

async function deleteAccount() {
  const ok = window.confirm("Radera ditt konto och din profil för alltid? Det går inte att ångra.");
  if (!ok) return;
  const btn = $("delete-btn");
  setBusy(btn, true, "Raderar…");
  const { error } = await sb.rpc("delete_my_account");
  if (error) {
    setBusy(btn, false);
    showMsg("profile-msg", dbErrorText(error));
    return;
  }
  // Kontot finns inte längre på servern, så vi rensar bara inloggningen på den här mobilen.
  await sb.auth.signOut({ scope: "local" });
  setBusy(btn, false);
  showMsg("auth-msg", "Ditt konto är raderat.", "ok");
}

// ---------- Start ----------

// Läs av länkar från mejl innan Supabase tar hand om dem.
function readEmailLink() {
  const params = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  const error = params.get("error_description") || params.get("error");
  if (error) {
    history.replaceState(null, "", location.pathname);
    const expired = params.get("error_code") === "otp_expired";
    return { type: null, error: expired ? "Länken i mejlet har gått ut eller redan använts. Försök igen." : "Länken i mejlet fungerade inte: " + error };
  }
  return { type: params.get("access_token") ? params.get("type") : null, error: null };
}

function initAccount() {
  buildColorChoices();
  $("tab-login").addEventListener("click", () => setSignupMode(false));
  $("tab-signup").addEventListener("click", () => setSignupMode(true));
  $("auth-form").addEventListener("submit", submitAuth);
  $("forgot-btn").addEventListener("click", forgotPassword);
  $("recovery-form").addEventListener("submit", submitNewPassword);
  $("profile-form").addEventListener("submit", saveProfile);
  $("logout-btn").addEventListener("click", logout);
  $("delete-btn").addEventListener("click", deleteAccount);
  $("account-retry").addEventListener("click", () => {
    if (!currentUser) return;
    showAccountBox("account-loading");
    loadProfile(currentUser);
  });

  const cfg = window.PULSE_CONFIG;
  const problem = configProblem(cfg);
  if (problem) {
    $("account-setup-text").textContent = problem;
    showAccountBox("account-setup");
    return;
  }

  const link = readEmailLink();
  if (link.type === "recovery") recoveryMode = true;
  if (link.type || link.error) showView("profile");

  sb = supabase.createClient(cfg.supabaseUrl.trim(), cfg.supabaseKey.trim(), {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  sb.auth.onAuthStateChange((event, session) => {
    const user = session ? session.user : null;
    if (event === "PASSWORD_RECOVERY") recoveryMode = true;
    if (event === "SIGNED_OUT") recoveryMode = false;

    const userChanged = (user && user.id) !== (currentUser && currentUser.id);
    currentUser = user;
    if (userChanged) {
      currentProfile = null;
      profileLoadId++;
      showMsg("profile-msg", "");
      $("auth-password").value = "";
      if (user) setSignupMode(false);
    }
    render();

    // Supabase rekommenderar att inte vänta på andra anrop inne i den här funktionen, därför setTimeout.
    if (user && userChanged) setTimeout(() => loadProfile(user), 0);

    if (event === "SIGNED_IN" && link.type === "signup") {
      showMsg("profile-msg", "E-posten är bekräftad. Välkommen till PULSE!", "ok");
      link.type = null;
    }
    if (event === "INITIAL_SESSION" && link.error) {
      showMsg(user ? "profile-msg" : "auth-msg", link.error);
      link.error = null;
    }
  });
}

initAccount();
