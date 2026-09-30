<script lang="ts">
	let { data } = $props();
	let count = $state(0);
</script>

<h1>{data.title}</h1>
<p>Rendered on the server at {data.renderedBy}.</p>
<button type="button" onclick={() => count++}>Clicked {count} times</button>
<nav><a href="/about">About</a></nav>
