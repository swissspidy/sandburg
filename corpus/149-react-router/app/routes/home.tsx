import TodoFeature from '../components/TodoFeature';
import IconsFeature from '../components/IconsFeature';
import FetchFeature from '../components/FetchFeature';
import FormFeature from '../components/FormFeature';

export function meta() {
  return [{ title: 'Garden Tracker' }];
}

export default function Home() {
  return (
    <main>
      <h1>Garden Tracker</h1>
      <TodoFeature />
      <IconsFeature />
      <FetchFeature source="/api/products" />
      <FormFeature />
    </main>
  );
}
