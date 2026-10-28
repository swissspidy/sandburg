import { Title } from '@solidjs/meta';
import ModalFeature from '../components/ModalFeature';
import TodoFeature from '../components/TodoFeature';
import TabsFeature from '../components/TabsFeature';

export default function Home() {
  return (
    <main>
      <Title>Movie Tracker</Title>
      <h1>Movie Tracker</h1>
      <ModalFeature />
      <TodoFeature />
      <TabsFeature />
    </main>
  );
}
