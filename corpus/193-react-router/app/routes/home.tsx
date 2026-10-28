import IconsFeature from '../components/IconsFeature';
import ConverterFeature from '../components/ConverterFeature';
import TodoFeature from '../components/TodoFeature';
import StoreFeature from '../components/StoreFeature';

export function meta() {
  return [{ title: 'Habit Tracker' }];
}

export default function Home() {
  const settings = (globalThis as any).__APP_SETTINGS__;
  const theme = settings.theme;
  return (
    <main data-theme={theme}>
      <h1>Habit Tracker</h1>
      <IconsFeature />
      <ConverterFeature />
      <TodoFeature />
      <StoreFeature />
    </main>
  );
}
