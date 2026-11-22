// Song search behind one interface so the mock and Apple Music are interchangeable.
//   search(term) -> Promise<[{ id, title, artist, durationMs, artworkUrl }]>
// `id` must be the Apple Music catalogue song ID (digits).

const MOCK_ARTISTS = [
  'The Paper Kites', 'Middle Kids', 'Sampa the Great', 'Tame Impala', 'Courtney Barnett',
  'Ball Park Music', 'Spacey Jane', 'Gang of Youths', 'Angie McMahon', 'Lime Cordiale',
  'Thelma Plum', 'Ruel', 'Peking Duk', 'San Cisco', 'Vance Joy', 'Julia Jacklin',
];
const MOCK_WORDS = [
  'Summer', 'Night', 'Drive', 'Gold', 'River', 'Echo', 'Paper', 'Heart', 'Coast', 'Neon',
  'Static', 'Honey', 'Fever', 'Ghost', 'Satellite', 'Tides', 'Velvet', 'Signal', 'Dust', 'Bloom',
];

// Deterministic fake catalogue. Durations are short (25 to 45 s) so a test game is quick.
function buildMockCatalogue() {
  const songs = [];
  let n = 0;
  for (let a = 0; a < MOCK_ARTISTS.length; a++) {
    for (let k = 0; k < 6; k++) {
      const w1 = MOCK_WORDS[(a * 7 + k * 3) % MOCK_WORDS.length];
      const w2 = MOCK_WORDS[(a * 5 + k * 11 + 4) % MOCK_WORDS.length];
      songs.push({
        id: String(900000000 + n),
        title: w1 === w2 ? w1 : `${w1} ${w2}`,
        artist: MOCK_ARTISTS[a],
        durationMs: 25000 + ((n * 7919) % 21) * 1000,
        artworkUrl: null,
      });
      n++;
    }
  }
  return songs;
}

export class MockCatalog {
  constructor() {
    this.songs = buildMockCatalogue();
    this.label = 'Test catalogue (mock songs)';
  }
  async search(term) {
    const q = term.trim().toLowerCase();
    if (!q) return [];
    return this.songs
      .filter((s) => s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q))
      .slice(0, 25);
  }
}

// Calls the `catalog-search` Supabase Edge Function, which queries the Apple Music API
// (Australian storefront) with a server-held developer token. Not yet deployed.
export class AppleMusicProxyCatalog {
  constructor(supabase) {
    this.supabase = supabase;
    this.label = 'Apple Music';
  }
  async search(term) {
    const q = term.trim();
    if (!q) return [];
    const { data, error } = await this.supabase.functions.invoke('catalog-search', { body: { term: q } });
    if (error) throw new Error('search_failed');
    return data.songs;
  }
}
