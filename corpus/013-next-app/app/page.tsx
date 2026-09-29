import FetchFeature from './components/FetchFeature';
import TodoFeature from './components/TodoFeature';
import StoreFeature from './components/StoreFeature';
import ModalFeature from './components/ModalFeature';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Study Tracker</h1>
        <FetchFeature source="/api/products" />
        <TodoFeature />
        <StoreFeature />
        <ModalFeature />
      </main>
  );
}
