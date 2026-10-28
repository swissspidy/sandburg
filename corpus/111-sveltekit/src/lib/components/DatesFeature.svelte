<script lang="ts">
  import { addDays, format } from 'date-fns';

  const START = new Date(2025, 0, 30);
  const due = format(addDays(START, 2), 'EEEE, MMMM d');
</script>

<section aria-label="Schedule">
  <p data-testid="due">Due {due}</p>
</section>
