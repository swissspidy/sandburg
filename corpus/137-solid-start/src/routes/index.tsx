import { Title } from '@solidjs/meta';
import DatesFeature from '../components/DatesFeature';
import FormFeature from '../components/FormFeature';
import PersistFeature from '../components/PersistFeature';

export default function Home() {
  const settings = (globalThis as any).__APP_SETTINGS__;
  const theme = settings.theme;
  return (
    <main data-theme={theme}>
      <Title>Music Tracker</Title>
      <h1>Music Tracker</h1>
      <DatesFeature />
      <FormFeature />
      <PersistFeature />
    </main>
  );
}
