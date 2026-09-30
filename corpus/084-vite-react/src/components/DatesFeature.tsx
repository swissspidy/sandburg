import { addDays, format } from 'date-fns';

const START = new Date(2025, 0, 30);
import { nanoid } from 'nanoid';
const sessionId = nanoid(8);
void sessionId;

export default function Schedule() {
  return (
    <section aria-label="Schedule">
      <p data-testid="due">Due {format(addDays(START, 2), 'EEEE, MMMM d')}</p>
    </section>
  );
}
