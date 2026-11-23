<script setup lang="ts">
interface Note {
  id: number;
  text: string;
  pinned: boolean;
}

const props = defineProps<{ note: Note }>();
const emit = defineEmits<{ pin: [id: number]; remove: [id: number] }>();
</script>

<template>
  <li :class="{ pinned: props.note.pinned }">
    <span>{{ props.note.text }}</span>
    <button type="button" :aria-label="(props.note.pinned ? 'Unpin ' : 'Pin ') + props.note.text" @click="emit('pin', props.note.id)">
      {{ props.note.pinned ? 'Unpin' : 'Pin' }}
    </button>
    <button type="button" :aria-label="'Delete ' + props.note.text" @click="emit('remove', props.note.id)">Delete</button>
  </li>
</template>

<style scoped>
span {
  flex: 1;
}
.pinned {
  margin: 0 -0.75rem;
  padding-inline: 0.75rem;
  border-radius: 8px;
  background: var(--accent-soft);
}
.pinned span {
  font-weight: 600;
}
button {
  padding: 0.3rem 0.7rem;
  font-size: 0.875rem;
  background: transparent;
  color: var(--text);
  border-color: var(--border);
}
button:hover {
  filter: none;
  background: var(--bg);
}
</style>
