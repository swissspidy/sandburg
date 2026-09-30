import ModalFeature from '../components/ModalFeature';
import SearchFeature from '../components/SearchFeature';
import DatesFeature from '../components/DatesFeature';

export default function Home() {
  return (
    <main>
        <h1>Music Tracker</h1>
        <ModalFeature />
        <SearchFeature />
        <DatesFeature />
      </main>
  );
}
