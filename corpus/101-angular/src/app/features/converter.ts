import { Component, computed, signal } from '@angular/core';

@Component({
  selector: 'app-converter',
  template: `
    <section aria-label="Converter">
      <label for="celsius">Celsius</label>
      <input #input id="celsius" type="number" [value]="celsius()" (input)="celsius.set(input.value)" />
      <output data-testid="fahrenheit">{{ fahrenheit() }} °F</output>
    </section>
  `,
})
export class ConverterFeature {
  readonly celsius = signal('0');
  readonly fahrenheit = computed(() => {
    const f = (Number(this.celsius()) * 9) / 5 + 32;
    return Number.isFinite(f) ? f.toFixed(1) : '—';
  });
}
