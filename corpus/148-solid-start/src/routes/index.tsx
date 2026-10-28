import { Title } from '@solidjs/meta';
import ConverterFeature from '../components/ConverterFeature';
import PersistFeature from '../components/PersistFeature';

export default function Home() {
  return (
    <main>
      <Title>Music Tracker</Title>
      <h1>Music Tracker</h1>
      <ConverterFeature />
      <PersistFeature />
    </main>
  );
}
