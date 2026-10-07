import './globals.css';

export const metadata = { title: 'Notes' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
