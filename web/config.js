// Public client configuration. The anon key is designed to be public: every privileged
// rule is enforced in the database, not by keeping this key secret.
// These defaults point at a local `supabase start` stack.
window.LAST_TRACK_CONFIG = {
  supabaseUrl: 'http://127.0.0.1:54321',
  supabaseAnonKey: 'REPLACE_WITH_ANON_KEY',
  catalog: 'mock', // 'mock' | 'apple'
  realtime: true,  // live updates; polling every pollMs is the fallback
  pollMs: 10000,
};
