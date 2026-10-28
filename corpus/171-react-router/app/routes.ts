import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [index('routes/home.tsx'), route('api/products', 'routes/api.products.ts')] satisfies RouteConfig;
