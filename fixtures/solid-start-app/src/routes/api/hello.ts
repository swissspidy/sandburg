import { json } from '@solidjs/router';

export function GET() {
  return json({ message: 'Hello from a SolidStart API route' });
}
