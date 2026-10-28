import StoreFeature from '../components/StoreFeature';
import SearchFeature from '../components/SearchFeature';
import PersistFeature from '../components/PersistFeature';

export function meta() {
  return [{ title: 'Garden Tracker' }];
}

export default function Home() {
  return (
    <main>
      <h1>Garden Tracker</h1>
      <StoreFeature />
      <SearchFeature />
      <PersistFeature />
    </main>
  );
}
