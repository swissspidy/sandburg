import TodoFeature from './components/TodoFeature';
import IconsFeature from './components/IconsFeature';
import StoreFeature from './components/StoreFeature';

export default function App() {
  const settings = (globalThis as any).__APP_SETTINGS__;
  const theme = settings.theme;
  return (
    <main data-theme={theme}>
        <h1>Study Tracker</h1>
        <TodoFeature />
        <IconsFeature />
        <StoreFeature />
      </main>
  );
}
