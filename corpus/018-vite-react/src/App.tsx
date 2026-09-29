import ConverterFeature from './components/ConverterFeature';
import StoreFeature from './components/StoreFeature';
import PersistFeature from './components/PersistFeature';

export default function App() {
  return (
    <main>
        <h1>Garden Tracker</h1>
        <ConverterFeature />
        <StoreFeature />
        <PersistFeature />
      </main>
  );
}
