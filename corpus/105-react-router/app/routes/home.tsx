import ModalFeature from '../components/ModalFeature';
import DatesFeature from '../components/DatesFeature';
import FormFeature from '../components/FormFeature';

export function meta() {
  return [{ title: 'Music Tracker' }];
}

export default function Home() {
  return (
    <main>
      <h1>Music Tracker</h1>
      <ModalFeature />
      <DatesFeature />
      <FormFeature />
    </main>
  );
}
