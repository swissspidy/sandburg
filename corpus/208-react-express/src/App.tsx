import FetchFeature from './components/FetchFeature';
import DatesFeature from './components/DatesFeature';
import TabsFeature from './components/TabsFeature';
import ConverterFeature from './components/ConverterFeature';

export default function App() {
  return (
    <main>
      <h1>Study Tracker</h1>
      <FetchFeature source="/api/products" />
      <DatesFeature />
      <TabsFeature />
      <ConverterFeature />
    </main>
  );
}
