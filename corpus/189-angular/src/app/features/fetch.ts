import { Component, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';

interface Product {
  id: number;
  name: string;
  price: number;
}

@Component({
  selector: 'app-fetch',
  template: `
    @if (error()) {
      <p role="alert">Failed to load products: {{ error() }}</p>
    } @else if (!items()) {
      <p>Loading…</p>
    } @else {
      <section aria-label="Products">
        <ul>
          @for (p of items() ?? []; track p.id) {
            <li>{{ p.name }} — \${{ p.price }}</li>
          }
        </ul>
      </section>
    }
  `,
})
export class FetchFeature {
  private readonly http = inject(HttpClient);
  readonly items = signal<Product[] | null>(null);
  readonly error = signal('');

  constructor() {
    this.http.get<{ products: Product[] }>('/data/products.json').subscribe({
      next: (data) => this.items.set(data.products),
      error: (e: unknown) => this.error.set(String(e)),
    });
  }
}
