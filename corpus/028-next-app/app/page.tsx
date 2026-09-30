import ModalFeature from './components/ModalFeature';
import SearchFeature from './components/SearchFeature';
import ConverterFeature from './components/ConverterFeature';
import StoreFeature from './components/StoreFeature';
import TailwindModalFeature from './components/TailwindModalFeature';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Garden Tracker</h1>
        <ModalFeature />
        <SearchFeature />
        <ConverterFeature />
        <StoreFeature />
        <TailwindModalFeature />
      </main>
  );
}
