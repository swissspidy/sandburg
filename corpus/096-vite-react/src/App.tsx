import IconsFeature from './components/IconsFeature';
import TabsFeature from './components/TabsFeature';
import DatesFeature from './components/DatesFeature';
import SearchFeature from './components/SearchFeature';

export default function App() {
  return (
    <main>
        <h1>Workout Tracker</h1>
        <IconsFeature />
        <TabsFeature />
        <DatesFeature />
        <SearchFeature />
      </main>
  );
}
