// Apple Music catalogue search for the player website (Australian storefront only).
//
// The MusicKit private key never leaves the server. Required function secrets:
//   APPLE_MUSIC_TEAM_ID      10-character Apple Developer Team ID
//   APPLE_MUSIC_KEY_ID       10-character MusicKit key ID
//   APPLE_MUSIC_PRIVATE_KEY  contents of the downloaded AuthKey_XXXXXXXXXX.p8 file
//
// Supabase verifies the caller's JWT before this runs (anonymous player sessions count).
// Songs without playParams are not playable in the AU catalogue and are dropped, so a
// player can only ever nominate a track the host's Apple Music can play.

const STOREFRONT = 'au';
const TOKEN_TTL_S = 60 * 60 * 12; // well under Apple's 6-month maximum

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

let cached: { token: string; exp: number } | null = null;

function b64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function developerToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 300 > now) return cached.token;
  const teamId = Deno.env.get('APPLE_MUSIC_TEAM_ID');
  const keyId = Deno.env.get('APPLE_MUSIC_KEY_ID');
  const pem = Deno.env.get('APPLE_MUSIC_PRIVATE_KEY');
  if (!teamId || !keyId || !pem) throw new Error('apple_music_not_configured');

  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const exp = now + TOKEN_TTL_S;
  const unsigned = `${b64url(JSON.stringify({ alg: 'ES256', kid: keyId }))}.${b64url(JSON.stringify({ iss: teamId, iat: now, exp }))}`;
  // WebCrypto returns the raw r||s signature, which is what JWS ES256 expects.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  cached = { token: `${unsigned}.${b64url(sig)}`, exp };
  return cached.token;
}

type AppleSong = {
  id: string;
  attributes?: {
    name?: string;
    artistName?: string;
    durationInMillis?: number;
    artwork?: { url?: string };
    playParams?: unknown;
  };
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'content-type': 'application/json' } });

  try {
    const { term } = await req.json().catch(() => ({ term: '' }));
    const q = String(term ?? '').trim().slice(0, 100);
    if (!q) return json({ songs: [] });

    const url = new URL(`https://api.music.apple.com/v1/catalog/${STOREFRONT}/search`);
    url.searchParams.set('term', q);
    url.searchParams.set('types', 'songs');
    url.searchParams.set('limit', '25');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await developerToken()}` } });
    if (!res.ok) return json({ error: 'search_failed' }, 502);

    const body = await res.json();
    const data: AppleSong[] = body?.results?.songs?.data ?? [];
    const songs = data
      .filter((s) => /^\d+$/.test(s.id) && s.attributes?.playParams && s.attributes?.name && s.attributes?.artistName)
      .map((s) => ({
        id: s.id,
        title: s.attributes!.name!,
        artist: s.attributes!.artistName!,
        durationMs: s.attributes!.durationInMillis ?? null,
        artworkUrl: s.attributes!.artwork?.url?.replace('{w}', '160').replace('{h}', '160') ?? null,
      }));
    return json({ songs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'search_failed';
    return json({ error: msg === 'apple_music_not_configured' ? msg : 'search_failed' }, 500);
  }
});
