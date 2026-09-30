import ModalFeature from './components/ModalFeature';
import ConverterFeature from './components/ConverterFeature';
import TodoFeature from './components/TodoFeature';
import DatesFeature from './components/DatesFeature';

export default function App() {
  return (
    <main>
        <h1>Budget Tracker</h1>
        <ModalFeature />
        <ConverterFeature />
        <TodoFeature />
        <DatesFeature />
      </main>
  );
}
