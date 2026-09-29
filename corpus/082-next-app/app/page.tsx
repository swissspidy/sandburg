import PersistFeature from './components/PersistFeature';
import ModalFeature from './components/ModalFeature';
import TodoFeature from './components/TodoFeature';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Reading Tracker</h1>
        <PersistFeature />
        <ModalFeature />
        <TodoFeature />
      </main>
  );
}
