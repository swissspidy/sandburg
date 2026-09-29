import IconsFeature from '../components/IconsFeature';
import ConverterFeature from '../components/ConverterFeature';
import PersistFeature from '../components/PersistFeature';
import SearchFeature from '../components/SearchFeature';

export default function Home() {
  return (
    <main>
        <h1>Travel Tracker</h1>
        <IconsFeature />
        <ConverterFeature />
        <PersistFeature />
        <SearchFeature />
      </main>
  );
}
