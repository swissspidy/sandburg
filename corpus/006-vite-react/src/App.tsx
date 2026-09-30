import RouterFeature from './components/RouterFeature';
import IconsFeature from './components/IconsFeature';
import SearchFeature from './components/SearchFeature';
import ModalFeature from './components/ModalFeature';
import TailwindModalFeature from './components/TailwindModalFeature';

export default function App() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Reading Tracker</h1>
        <RouterFeature />
        <IconsFeature />
        <SearchFeature />
        <ModalFeature />
        <TailwindModalFeature />
      </main>
  );
}
