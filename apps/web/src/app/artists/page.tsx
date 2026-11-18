import { PublicShell } from '@/components/PublicShell';
import { API_BASE } from '@/lib/api';

interface Artist {
  id: string;
  name: string;
  bio: string | null;
  image_url: string | null;
  links_json: string;
}

async function getArtists(): Promise<Artist[]> {
  try {
    const response = await fetch(`${API_BASE}/public/artists`, { cache: 'no-store' });
    if (!response.ok) return [];
    const data = await response.json() as { artists?: Artist[] };
    return data.artists ?? [];
  } catch {
    return [];
  }
}

export const metadata = { title: 'Artists · Virgo Boys Radio' };

export default async function ArtistsPage() {
  const artists = await getArtists();

  return (
    <PublicShell>
      <div className="space-y-10">
        <div className="space-y-2">
          <p className="text-[0.6rem] uppercase tracking-[0.45em] text-muted font-mono">Virgo Boys Radio</p>
          <h1 className="text-4xl font-bold uppercase tracking-[0.15em] text-ink">Artists</h1>

        </div>

        {artists.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {artists.map((artist) => {
                const links = (() => {
                  try { return JSON.parse(artist.links_json) as { label: string; url: string }[]; } catch { return []; }
                })();

                return (
                  <article key={artist.id} className="border border-ink/10 bg-paper p-5 space-y-4">
                    {artist.image_url ? (
                      <div className="aspect-[4/3] overflow-hidden bg-stone-100">
                        <img src={artist.image_url} alt={artist.name} className="h-full w-full object-cover" />
                      </div>
                    ) : null}
                    <div className="space-y-2">
                      <h3 className="text-lg font-semibold text-ink">{artist.name}</h3>
                      {artist.bio ? <p className="text-sm leading-7 text-muted">{artist.bio}</p> : null}
                      {links.length > 0 ? (
                        <div className="flex flex-wrap gap-2 pt-2">
                          {links.map((link) => (
                            <a
                              key={`${artist.id}-${link.label}`}
                              href={link.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs uppercase tracking-[0.25em] text-ink underline decoration-ink/20 underline-offset-4"
                            >
                              {link.label}
                            </a>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </article>
                );
              })}
          </div>
        ) : (
          <p className="text-sm text-muted">Hear who's playing. <a href="/" className="font-semibold text-ink underline underline-offset-4">Listen to the station</a>.</p>
        )}
      </div>
    </PublicShell>
  );
}
