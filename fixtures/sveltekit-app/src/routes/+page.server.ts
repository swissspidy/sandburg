import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	return { title: 'Welcome to SvelteKit', renderedBy: 'load()' };
};
