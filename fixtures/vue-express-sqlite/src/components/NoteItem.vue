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
li {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  padding: 0.25rem 0;
}
span {
  flex: 1;
}
.pinned span {
  font-weight: 700;
}
</style>
