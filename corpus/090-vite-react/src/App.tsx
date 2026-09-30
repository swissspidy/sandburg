import RouterFeature from './components/RouterFeature';
import ConverterFeature from './components/ConverterFeature';
import FormFeature from './components/FormFeature';
import TailwindModalFeature from './components/TailwindModalFeature';

export default function App() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Study Tracker</h1>
        <RouterFeature />
        <ConverterFeature />
        <FormFeature />
        <TailwindModalFeature />
      </main>
  );
}
