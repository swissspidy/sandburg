import FetchFeature from './components/FetchFeature';
import DatesFeature from './components/DatesFeature';
import CounterFeature from './components/CounterFeature';

export default function App() {
  return (
    <main>
      <h1>Recipe Tracker</h1>
      <FetchFeature source="/api/products" />
      <DatesFeature />
      <CounterFeature />
    </main>
  );
}
