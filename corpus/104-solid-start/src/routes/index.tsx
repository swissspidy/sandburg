import { Title } from '@solidjs/meta';
import CounterFeature from '../components/CounterFeature';
import ModalFeature from '../components/ModalFeature';

export default function Home() {
  return (
    <main>
      <Title>Workout Tracker</Title>
      <h1>Workout Tracker</h1>
      <CounterFeature />
      <ModalFeature />
    </main>
  );
}
