<script lang="ts">
	import favicon from '#lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<main>
	{@render children()}
</main>

<style>
	:global(:root) {
		--accent: #c73600;
		--bg: #f4f5f7;
		--surface: #fff;
		--text: #1d2127;
		--muted: #5d6470;
		--border: #dde1e6;
		font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
		line-height: 1.5;
		color: var(--text);
		background: var(--bg);
	}
	:global(body) {
		margin: 0;
	}
	:global(h1) {
		margin: 0 0 0.75rem;
		font-size: 1.6rem;
		line-height: 1.2;
		letter-spacing: -0.01em;
	}
	:global(a) {
		color: var(--accent);
		font-weight: 500;
	}
	:global(:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	main {
		box-sizing: border-box;
		max-width: 34rem;
		margin: 2.5rem auto;
		padding: 1.75rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 14px;
		box-shadow:
			0 1px 2px rgb(0 0 0 / 0.04),
			0 8px 24px rgb(0 0 0 / 0.06);
	}
</style>
