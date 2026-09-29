import ConverterFeature from './components/ConverterFeature';
import PersistFeature from './components/PersistFeature';

export default function Home() {
  return (
    <main>
        <h1>Garden Tracker</h1>
        <ConverterFeature />
        <PersistFeature />
      </main>
  );
}
