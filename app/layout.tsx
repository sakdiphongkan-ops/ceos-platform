import './globals.css';

export const metadata = {
  title: 'CEOS AI Investment System',
  description: 'AI driven portfolio intelligence platform',
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
