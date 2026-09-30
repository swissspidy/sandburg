import FormFeature from './components/FormFeature';
import SearchFeature from './components/SearchFeature';
import TabsFeature from './components/TabsFeature';
import CounterFeature from './components/CounterFeature';

export default function Home() {
  return (
    <main>
        <h1>Garden Tracker</h1>
        <FormFeature />
        <SearchFeature />
        <TabsFeature />
        <CounterFeature />
      </main>
  );
}
