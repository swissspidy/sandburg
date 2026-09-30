import PersistFeature from './components/PersistFeature';
import DatesFeature from './components/DatesFeature';

export default function Home() {
  return (
    <main>
        <h1>Music Tracker</h1>
        <PersistFeature />
        <DatesFeature />
      </main>
  );
}
