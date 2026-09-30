import type { APIRoute } from 'astro';

export const GET: APIRoute = () => {
  return new Response(JSON.stringify({ message: 'Hello from an Astro endpoint' }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
