import SearchFeature from './components/SearchFeature';
import DatesFeature from './components/DatesFeature';
import TabsFeature from './components/TabsFeature';
import StoreFeature from './components/StoreFeature';

export default function App() {
  return (
    <main>
        <h1>Reading Tracker</h1>
        <SearchFeature />
        <DatesFeature />
        <TabsFeature />
        <StoreFeature />
      </main>
  );
}
