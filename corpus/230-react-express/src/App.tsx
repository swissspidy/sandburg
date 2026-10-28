import FetchFeature from './components/FetchFeature';
import StoreFeature from './components/StoreFeature';

export default function App() {
  return (
    <main>
      <h1>Budget Tracker</h1>
      <FetchFeature source="/api/products" />
      <StoreFeature />
    </main>
  );
}
