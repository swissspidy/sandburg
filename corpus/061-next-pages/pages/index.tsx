import CounterFeature from '../components/CounterFeature';
import FetchFeature from '../components/FetchFeature';
import ModalFeature from '../components/ModalFeature';
import IconsFeature from '../components/IconsFeature';

export default function Home() {
  return (
    <main>
        <h1>Movie Tracker</h1>
        <CounterFeature />
        <FetchFeature source="/api/products" />
        <ModalFeature />
        <IconsFeature />
      </main>
  );
}
