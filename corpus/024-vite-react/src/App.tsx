import ModalFeature from './components/ModalFeature';
import DatesFeature from './components/DatesFeature';
import TabsFeature from './components/TabsFeature';
import TodoFeature from './components/TodoFeature';

export default function App() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Recipe Tracker</h1>
        <ModalFeature />
        <DatesFeature />
        <TabsFeature />
        <TodoFeature />
      </main>
  );
}
