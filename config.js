// PULSE – inställningar för Supabase (etapp 3)
//
// Klistra in dina två värden från Supabase mellan citattecknen:
//   supabaseUrl: din "Project URL", ser ut som https://abcdefgh.supabase.co
//   supabaseKey: din "Publishable key" (börjar med sb_publishable_) eller den äldre "anon public"-nyckeln
//
// Båda värdena är OFFENTLIGA och får ligga i koden. Databasen skyddas av Row Level Security.
// Lägg ALDRIG in "secret"-nyckeln (sb_secret_...) eller "service_role" här. Appen vägrar använda dem.
window.PULSE_CONFIG = {
  supabaseUrl: "",
  supabaseKey: "",
};
