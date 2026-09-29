import RouterFeature from './components/RouterFeature';
import PersistFeature from './components/PersistFeature';
import IconsFeature from './components/IconsFeature';
import ModalFeature from './components/ModalFeature';

export default function App() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Budget Tracker</h1>
        <RouterFeature />
        <PersistFeature />
        <IconsFeature />
        <ModalFeature />
      </main>
  );
}
