// Public client configuration. The publishable key is designed to be public: every
// privileged rule is enforced in the database, not by keeping this key secret.
window.LAST_TRACK_CONFIG = {
  supabaseUrl: 'https://mqvekdrqxxwyhsudfxyy.supabase.co',
  supabaseAnonKey: 'sb_publishable_wRHmy29B8vdoeye6C6tXuw_aUzo760p',
  catalog: 'mock', // switch to 'apple' once the Apple Music search function has its key
  realtime: true,  // live updates; polling every pollMs is the fallback
  pollMs: 10000,
};
