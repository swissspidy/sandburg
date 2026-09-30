import FetchFeature from '../components/FetchFeature';
import TodoFeature from '../components/TodoFeature';
import TailwindModalFeature from '../components/TailwindModalFeature';

export default function Home() {
  const settings = (globalThis as any).__APP_SETTINGS__;
  const theme = settings.theme;
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6" data-theme={theme}>
        <h1 className="text-2xl font-bold">Garden Tracker</h1>
        <FetchFeature source="/api/products" />
        <TodoFeature />
        <TailwindModalFeature />
      </main>
  );
}
