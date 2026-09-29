import TabsFeature from './components/TabsFeature';
import SearchFeature from './components/SearchFeature';
import ConverterFeature from './components/ConverterFeature';
import ModalFeature from './components/ModalFeature';

export default function App() {
  return (
    <main>
        <h1>Reading Tracker</h1>
        <TabsFeature />
        <SearchFeature />
        <ConverterFeature />
        <ModalFeature />
      </main>
  );
}
