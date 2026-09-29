import FormFeature from './components/FormFeature';
import FetchFeature from './components/FetchFeature';
import SearchFeature from './components/SearchFeature';

export default function Home() {
  return (
    <main>
        <h1>Garden Tracker</h1>
        <FormFeature />
        <FetchFeature source="/api/products" />
        <SearchFeature />
      </main>
  );
}
