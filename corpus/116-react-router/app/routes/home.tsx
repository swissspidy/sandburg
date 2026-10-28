import CounterFeature from '../components/CounterFeature';
import SearchFeature from '../components/SearchFeature';

export function meta() {
  return [{ title: 'Recipe Tracker' }];
}

export default function Home() {
  return (
    <main>
      <h1>Recipe Tracker</h1>
      <CounterFeature />
      <SearchFeature />
    </main>
  );
}
