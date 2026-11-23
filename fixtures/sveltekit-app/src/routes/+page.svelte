<script lang="ts">
	let { data } = $props();
	let count = $state(0);
</script>

<h1>{data.title}</h1>
<p>Rendered on the server at {data.renderedBy}.</p>
<button type="button" onclick={() => count++}>Clicked {count} times</button>
<nav><a href="/about">About</a></nav>

<style>
	p {
		color: var(--muted);
	}
	button {
		font: inherit;
		font-weight: 500;
		font-variant-numeric: tabular-nums;
		padding: 0.45rem 0.9rem;
		border: 0;
		border-radius: 8px;
		background: var(--accent);
		color: #fff;
		cursor: pointer;
	}
	button:hover {
		background: color-mix(in srgb, var(--accent), black 15%);
	}
	nav {
		margin-top: 1.5rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
	}
</style>
