import TodoFeature from '../components/TodoFeature';
import TabsFeature from '../components/TabsFeature';
import ConverterFeature from '../components/ConverterFeature';
import FormFeature from '../components/FormFeature';

export function meta() {
  return [{ title: 'Study Tracker' }];
}

export default function Home() {
  return (
    <main>
      <h1>Study Tracker</h1>
      <TodoFeature />
      <TabsFeature />
      <ConverterFeature />
      <FormFeature />
    </main>
  );
}
