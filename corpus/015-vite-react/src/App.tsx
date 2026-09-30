import StoreFeature from './components/StoreFeature';
import TabsFeature from './components/TabsFeature';
import DatesFeature from './components/DatesFeature';

export default function App() {
  return (
    <main>
        <h1>Workout Tracker</h1>
        <StoreFeature />
        <TabsFeature />
        <DatesFeature />
      </main>
  );
}
