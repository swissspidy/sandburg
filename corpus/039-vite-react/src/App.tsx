import DatesFeature from './components/DatesFeature';
import RouterFeature from './components/RouterFeature';
import SearchFeature from './components/SearchFeature';
import FetchFeature from './components/FetchFeature';

export default function App() {
  return (
    <main>
        <h1>Pantry Tracker</h1>
        <DatesFeature />
        <RouterFeature />
        <SearchFeature />
        <FetchFeature source="/data/products.json" />
      </main>
  );
}
