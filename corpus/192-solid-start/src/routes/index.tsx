import { Title } from '@solidjs/meta';
import TabsFeature from '../components/TabsFeature';
import SearchFeature from '../components/SearchFeature';

export default function Home() {
  return (
    <main>
      <Title>Recipe Tracker</Title>
      <h1>Recipe Tracker</h1>
      <TabsFeature />
      <SearchFeature />
    </main>
  );
}
