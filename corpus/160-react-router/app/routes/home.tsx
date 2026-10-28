import StoreFeature from '../components/StoreFeature';
import PersistFeature from '../components/PersistFeature';
import ModalFeature from '../components/ModalFeature';

export function meta() {
  return [{ title: 'Study Tracker' }];
}

export default function Home() {
  return (
    <main>
      <h1>Study Tracker</h1>
      <StoreFeature />
      <PersistFeature />
      <ModalFeature />
    </main>
  );
}
