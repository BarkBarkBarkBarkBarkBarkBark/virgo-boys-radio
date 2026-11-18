import Link from 'next/link';

export function Header() {
  return (
    <header className="shrink-0 border-b border-ink/10 px-4 py-4 sm:px-6 sm:py-5">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Link
          href="/"
          className="text-sm font-bold uppercase leading-tight tracking-[0.16em] text-ink transition-colors hover:text-accent-red sm:text-lg"
        >
          VIRGO BOYS RADIO
        </Link>

        <nav className="flex items-center gap-1" aria-label="Site navigation">
          <Link
            href="/events"
            className="px-2 py-2 text-[11px] uppercase tracking-[0.2em] text-ink transition-colors hover:text-accent-red sm:px-3"
          >
            Events
          </Link>
        </nav>
      </div>
    </header>
  );
}
