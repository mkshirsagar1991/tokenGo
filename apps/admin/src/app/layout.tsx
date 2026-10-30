import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'TokenGo Admin', template: '%s · TokenGo Admin' },
  description: 'TokenGo administration portal',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = (await cookies()).get('tg_theme')?.value;
  const attr = theme === 'light' || theme === 'dark' ? theme : undefined;
  return (
    <html lang="en" data-theme={attr}>
      <body>{children}</body>
    </html>
  );
}
