import { Title } from '@solidjs/meta';
import SearchFeature from '../components/SearchFeature';
import TabsFeature from '../components/TabsFeature';
import ModalFeature from '../components/ModalFeature';

export default function Home() {
  return (
    <main>
      <Title>Garden Tracker</Title>
      <h1>Garden Tracker</h1>
      <SearchFeature />
      <TabsFeature />
      <ModalFeature />
    </main>
  );
}
