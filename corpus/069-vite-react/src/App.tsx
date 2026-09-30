import FormFeature from './components/FormFeature';
import ConverterFeature from './components/ConverterFeature';
import CounterFeature from './components/CounterFeature';
import RouterFeature from './components/RouterFeature';

export default function App() {
  return (
    <main>
        <h1>Reading Tracker</h1>
        <FormFeature />
        <ConverterFeature />
        <CounterFeature />
        <RouterFeature />
      </main>
  );
}
