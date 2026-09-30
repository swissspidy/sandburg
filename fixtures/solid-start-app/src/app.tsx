import { MetaProvider, Title } from '@solidjs/meta';
import { Router } from '@solidjs/router';
import { FileRoutes } from '@solidjs/start/router';
import { Suspense } from 'solid-js';

export default function App() {
  return (
    <Router
      root={(props) => (
        <MetaProvider>
          <Title>SolidStart</Title>
          <nav>
            <a href="/">Home</a> <a href="/about">About</a>
          </nav>
          <main>
            <Suspense>{props.children}</Suspense>
          </main>
        </MetaProvider>
      )}
    >
      <FileRoutes />
    </Router>
  );
}
