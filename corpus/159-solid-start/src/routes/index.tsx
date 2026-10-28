import { Title } from '@solidjs/meta';
import FormFeature from '../components/FormFeature';
import PersistFeature from '../components/PersistFeature';
import SearchFeature from '../components/SearchFeature';

export default function Home() {
  return (
    <main>
      <Title>Garden Tracker</Title>
      <h1>Garden Tracker</h1>
      <FormFeature />
      <PersistFeature />
      <SearchFeature />
    </main>
  );
}
