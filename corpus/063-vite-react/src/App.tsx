import IconsFeature from './components/IconsFeature';
import TabsFeature from './components/TabsFeature';
import FormFeature from './components/FormFeature';

export default function App() {
  const settings = (globalThis as any).__APP_SETTINGS__;
  const theme = settings.theme;
  return (
    <main data-theme={theme}>
        <h1>Budget Tracker</h1>
        <IconsFeature />
        <TabsFeature />
        <FormFeature />
      </main>
  );
}
