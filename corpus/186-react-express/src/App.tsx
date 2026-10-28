import FetchFeature from './components/FetchFeature';
import SearchFeature from './components/SearchFeature';
import IconsFeature from './components/IconsFeature';
import FormFeature from './components/FormFeature';

export default function App() {
  return (
    <main>
      <h1>Pantry Tracker</h1>
      <FetchFeature source="/api/products" />
      <SearchFeature />
      <IconsFeature />
      <FormFeature />
    </main>
  );
}
