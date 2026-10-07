'use client';

import { useOptimistic } from 'react';
import { likeEntry } from './actions.js';

export default function LikeButton({ id, name, likes }) {
  const [count, addLike] = useOptimistic(likes, (current) => current + 1);

  async function action() {
    addLike();
    await likeEntry(id);
  }

  return (
    <form action={action} className="like-row">
      <button
        type="submit"
        className="like-button"
        aria-label={`Like ${name}'s message`}
        title={`Like ${name}'s message`}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            d="M12 21s-7.5-4.6-9.6-9.3C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.1 4.4 2.5h1.8c.8-1.4 2.3-2.5 4.4-2.5 3.7 0 5.8 3.9 4.3 7.2C19.5 16.4 12 21 12 21z"
            fill="currentColor"
          />
        </svg>
      </button>
      <span className="like-count" aria-live="polite">
        {count === 1 ? '1 like' : `${count} likes`}
      </span>
    </form>
  );
}
