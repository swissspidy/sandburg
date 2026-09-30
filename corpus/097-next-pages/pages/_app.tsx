import type { AppProps } from 'next/app';
import Head from 'next/head';
import '../styles/globals.css';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <title>Budget Tracker</title>
      </Head>
      <Component {...pageProps} />
    </>
  );
}
