import './globals.css';

export const metadata = { title: 'Tip Calculator' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
