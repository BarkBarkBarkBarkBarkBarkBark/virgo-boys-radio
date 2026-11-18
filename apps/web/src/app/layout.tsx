import type { Metadata } from 'next';
import './globals.css';
import { AudioProvider } from '@/lib/AudioProvider';
import { PlayerBar } from '@/components/PlayerBar';

export const metadata: Metadata = {
  title: 'Virgo Boys Radio',
  description: 'Independent radio for live DJ sets and original music.',
  openGraph: {
    title: 'Virgo Boys Radio',
    description: 'Independent radio for live DJ sets and original music.',
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* Reserve the player bar and the device's bottom safe area. */}
      <body className="antialiased" style={{ paddingBottom: 'var(--player-bar-height)' }}>
        <AudioProvider>
          {children}
          <PlayerBar />
        </AudioProvider>
      </body>
    </html>
  );
}
