import FetchFeature from '../components/FetchFeature';
import CounterFeature from '../components/CounterFeature';

export function meta() {
  return [{ title: 'Chore Tracker' }];
}

export default function Home() {
  return (
    <main>
      <h1>Chore Tracker</h1>
      <FetchFeature source="/api/products" />
      <CounterFeature />
    </main>
  );
}
