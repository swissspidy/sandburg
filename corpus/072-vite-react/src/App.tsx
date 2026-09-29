import ConverterFeature from './components/ConverterFeature';
import ModalFeature from './components/ModalFeature';
import FetchFeature from './components/FetchFeature';
import TodoFeature from './components/TodoFeature';

export default function App() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Garden Tracker</h1>
        <ConverterFeature />
        <ModalFeature />
        <FetchFeature source="/data/products.json" />
        <TodoFeature />
      </main>
  );
}
