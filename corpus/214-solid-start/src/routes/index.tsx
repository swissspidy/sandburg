import { Title } from '@solidjs/meta';
import ConverterFeature from '../components/ConverterFeature';
import DatesFeature from '../components/DatesFeature';

export default function Home() {
  return (
    <main>
      <Title>Movie Tracker</Title>
      <h1>Movie Tracker</h1>
      <ConverterFeature />
      <DatesFeature />
    </main>
  );
}
