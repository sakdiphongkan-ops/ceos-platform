import './globals.css';
import { Manrope, Noto_Sans_Thai } from 'next/font/google';

const manrope = Manrope({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-manrope',
  weight: ['400', '500', '600', '700', '800'],
});

const notoSansThai = Noto_Sans_Thai({
  subsets: ['thai', 'latin'],
  display: 'swap',
  variable: '--font-noto-thai',
  weight: ['400', '500', '600', '700', '800'],
});

export const metadata = {
  title: 'LUNA-TH1H · Control Room',
  description: 'LUNA intraday systematic trading control room',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={manrope.variable + ' ' + notoSansThai.variable}>{children}</body>
    </html>
  );
}
