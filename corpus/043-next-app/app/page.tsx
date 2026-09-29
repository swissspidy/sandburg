import ModalFeature from './components/ModalFeature';
import IconsFeature from './components/IconsFeature';
import PersistFeature from './components/PersistFeature';
import StoreFeature from './components/StoreFeature';

export default function Home() {
  return (
    <main>
        <h1>Recipe Tracker</h1>
        <ModalFeature />
        <IconsFeature />
        <PersistFeature />
        <StoreFeature />
      </main>
  );
}
