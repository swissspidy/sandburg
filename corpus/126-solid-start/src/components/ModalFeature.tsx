import { createSignal, Show } from 'solid-js';

export default function ModalDemo() {
  const [open, setOpen] = createSignal(false);
  return (
    <section aria-label="Modal demo">
      <button type="button" onClick={() => setOpen(true)}>Open settings</button>
      <Show when={open()}>
        <div role="dialog" aria-label="Settings" aria-modal="true">
          <p>Settings go here.</p>
          <button type="button" onClick={() => setOpen(false)}>Close</button>
        </div>
      </Show>
    </section>
  );
}
