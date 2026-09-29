import { create } from 'zustand';

type Cart = { items: string[]; add: (item: string) => void };
const useCart = create<Cart>((set) => ({ items: [], add: (item) => set((s) => ({ items: [...s.items, item] })) }));

function CartBadge() {
  const count = useCart((s) => s.items.length);
  return <span data-testid="cart-count">{count} in cart</span>;
}

export default function Shop() {
  const add = useCart((s) => s.add);
  return (
    <section aria-label="Shop">
      <CartBadge />
      <button type="button" onClick={() => add('Tea')}>Add tea</button>
      <button type="button" onClick={() => add('Coffee')}>Add coffee</button>
    </section>
  );
}
