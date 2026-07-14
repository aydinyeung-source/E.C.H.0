// Supabase configuration, served directly to the browser.
//
// These are PUBLIC values: the publishable (anon) key is designed to live in
// client code, and Row Level Security (set up in supabase/schema.sql) is what
// actually protects the data. Never put the "secret"/service_role key here.
//
// Leave these blank to fall back to the offline (localStorage) leaderboard.
window.SUPABASE_URL = "https://ifxlffzfpxyyjyrsdads.supabase.co";
window.SUPABASE_ANON_KEY = "sb_publishable_oAzEDmElLQtprEyxpM6b-g_Mx8nAVyE";
