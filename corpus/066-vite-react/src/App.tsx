import FetchFeature from './components/FetchFeature';
import ModalFeature from './components/ModalFeature';
import TabsFeature from './components/TabsFeature';
import TailwindModalFeature from './components/TailwindModalFeature';

export default function App() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Travel Tracker</h1>
        <FetchFeature source="/data/products.json" />
        <ModalFeature />
        <TabsFeature />
        <TailwindModalFeature />
      </main>
  );
}
