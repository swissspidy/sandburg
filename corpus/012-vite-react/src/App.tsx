import FetchFeature from './components/FetchFeature';
import IconsFeature from './components/IconsFeature';
import FormFeature from './components/FormFeature';

export default function App() {
  return (
    <main>
        <h1>Budget Tracker</h1>
        <FetchFeature source="/data/products.json" />
        <IconsFeature />
        <FormFeature />
      </main>
  );
}
