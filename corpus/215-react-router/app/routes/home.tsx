import ConverterFeature from '../components/ConverterFeature';
import PersistFeature from '../components/PersistFeature';
import ModalFeature from '../components/ModalFeature';
import CounterFeature from '../components/CounterFeature';

export function meta() {
  return [{ title: 'Workout Tracker' }];
}

export default function Home() {
  return (
    <main>
      <h1>Workout Tracker</h1>
      <ConverterFeature />
      <PersistFeature />
      <ModalFeature />
      <CounterFeature />
    </main>
  );
}
