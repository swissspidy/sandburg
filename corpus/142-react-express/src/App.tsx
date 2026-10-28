import FetchFeature from './components/FetchFeature';
import TabsFeature from './components/TabsFeature';

export default function App() {
  return (
    <main>
      <h1>Habit Tracker</h1>
      <FetchFeature source="/api/products" />
      <TabsFeature />
    </main>
  );
}
