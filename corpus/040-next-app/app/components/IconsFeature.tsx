'use client';

import { useState } from 'react';
import { Heart } from 'lucide-react';
import clsx from 'clsx';

export default function LikeButton() {
  const [liked, setLiked] = useState(false);
  return (
    <section aria-label="Likes">
      <button type="button" aria-pressed={liked} className={clsx('like', liked && 'liked')} onClick={() => setLiked(!liked)}>
        <Heart aria-hidden="true" size={16} /> Like
      </button>
    </section>
  );
}
