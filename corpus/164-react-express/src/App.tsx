import FetchFeature from './components/FetchFeature';
import TabsFeature from './components/TabsFeature';
import StoreFeature from './components/StoreFeature';

export default function App() {
  return (
    <main>
      <h1>Workout Tracker</h1>
      <FetchFeature source="/api/products" />
      <TabsFeature />
      <StoreFeature />
    </main>
  );
}
