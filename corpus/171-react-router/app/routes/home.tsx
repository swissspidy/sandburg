import ConverterFeature from '../components/ConverterFeature';
import FetchFeature from '../components/FetchFeature';
import FormFeature from '../components/FormFeature';
import TodoFeature from '../components/TodoFeature';

export function meta() {
  return [{ title: 'Chore Tracker' }];
}

export default function Home() {
  return (
    <main>
      <h1>Chore Tracker</h1>
      <ConverterFeature />
      <FetchFeature source="/api/products" />
      <FormFeature />
      <TodoFeature />
    </main>
  );
}
