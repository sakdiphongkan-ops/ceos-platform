import './globals.css';

export const metadata = {
  title: 'LUNA-TH1H · Control Room',
  description: 'LUNA intraday systematic trading control room',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
