import ModalFeature from '../components/ModalFeature';
import SearchFeature from '../components/SearchFeature';
import TailwindModalFeature from '../components/TailwindModalFeature';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Pantry Tracker</h1>
        <ModalFeature />
        <SearchFeature />
        <TailwindModalFeature />
      </main>
  );
}
