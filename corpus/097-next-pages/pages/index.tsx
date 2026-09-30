import ModalFeature from '../components/ModalFeature';
import TabsFeature from '../components/TabsFeature';
import ConverterFeature from '../components/ConverterFeature';
import TailwindModalFeature from '../components/TailwindModalFeature';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Budget Tracker</h1>
        <ModalFeature />
        <TabsFeature />
        <ConverterFeature />
        <TailwindModalFeature />
      </main>
  );
}
