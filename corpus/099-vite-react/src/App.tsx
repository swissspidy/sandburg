import FetchFeature from './components/FetchFeature';
import IconsFeature from './components/IconsFeature';
import SearchFeature from './components/SearchFeature';
import StoreFeature from './components/StoreFeature';

export default function App() {
  return (
    <main>
        <h1>Workout Tracker</h1>
        <FetchFeature source="/data/products.json" />
        <IconsFeature />
        <SearchFeature />
        <StoreFeature />
      </main>
  );
}
