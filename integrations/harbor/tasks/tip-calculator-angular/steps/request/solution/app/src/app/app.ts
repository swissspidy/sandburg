import { Component, computed, signal } from '@angular/core';

function toNumber(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

@Component({
  selector: 'app-root',
  template: `
    <main class="shell">
      <section class="card" aria-labelledby="title">
        <header class="head">
          <span class="logo" aria-hidden="true">🧾</span>
          <div>
            <h1 id="title">Tip calculator</h1>
            <p class="sub">Split the bill without the mental math.</p>
          </div>
        </header>

        <form class="fields" (submit)="$event.preventDefault()">
          <div class="field">
            <label for="bill">Bill amount</label>
            <div class="input-wrap">
              <span class="affix" aria-hidden="true">$</span>
              <input
                id="bill"
                type="number"
                inputmode="decimal"
                min="0"
                step="0.01"
                placeholder="0.00"
                [value]="bill()"
                (input)="bill.set(asValue($event))"
                [attr.aria-invalid]="billInvalid()"
              />
            </div>
            @if (billInvalid()) {
              <p class="error">Bill can't be negative.</p>
            }
          </div>

          <div class="field">
            <label for="tip">Tip percent</label>
            <div class="input-wrap">
              <input
                id="tip"
                type="number"
                inputmode="decimal"
                min="0"
                step="1"
                placeholder="0"
                [value]="tip()"
                (input)="tip.set(asValue($event))"
                [attr.aria-invalid]="tipInvalid()"
              />
              <span class="affix" aria-hidden="true">%</span>
            </div>
            <div class="presets" role="group" aria-label="Quick tip percentages">
              @for (p of presets; track p) {
                <button
                  type="button"
                  class="chip"
                  [class.active]="tipValue() === p"
                  [attr.aria-pressed]="tipValue() === p"
                  (click)="tip.set(p.toString())"
                >
                  {{ p }}%
                </button>
              }
            </div>
            @if (tipInvalid()) {
              <p class="error">Tip can't be negative.</p>
            }
          </div>

          <div class="field">
            <label for="people">People</label>
            <div class="stepper">
              <button type="button" class="step" aria-label="Fewer people" (click)="adjustPeople(-1)" [disabled]="peopleValue() <= 1">−</button>
              <input
                id="people"
                type="number"
                inputmode="numeric"
                min="1"
                step="1"
                [value]="people()"
                (input)="people.set(asValue($event))"
                [attr.aria-invalid]="peopleInvalid()"
              />
              <button type="button" class="step" aria-label="More people" (click)="adjustPeople(1)">+</button>
            </div>
            @if (peopleInvalid()) {
              <p class="error">Use a whole number of at least 1. Calculating for {{ peopleValue() }}.</p>
            }
          </div>
        </form>

        <section class="results" aria-live="polite" aria-label="Results">
          <p class="row">Tip: <strong>{{ money(tipAmount()) }}</strong></p>
          <p class="row">Total: <strong>{{ money(total()) }}</strong></p>
          <p class="row highlight">Per person: <strong>{{ money(perPerson()) }}</strong></p>
        </section>

        <button type="button" class="reset" (click)="reset()">Reset</button>
      </section>
    </main>
  `,
  styles: `
    .shell {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px 16px;
      box-sizing: border-box;
    }
    .card {
      width: 100%;
      max-width: 440px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 28px;
      box-shadow: 0 10px 30px rgb(0 0 0 / 0.08);
      box-sizing: border-box;
    }
    .head { display: flex; gap: 14px; align-items: center; margin-bottom: 24px; }
    .logo {
      font-size: 28px; width: 52px; height: 52px; display: grid; place-items: center;
      background: var(--accent-soft); border-radius: 14px; flex-shrink: 0;
    }
    h1 { margin: 0; font-size: 1.4rem; letter-spacing: -0.01em; }
    .sub { margin: 2px 0 0; color: var(--muted); font-size: 0.92rem; }
    .fields { display: grid; gap: 18px; }
    .field { display: grid; gap: 6px; }
    label { font-weight: 600; font-size: 0.9rem; }
    .input-wrap {
      display: flex; align-items: center; border: 1px solid var(--border);
      border-radius: 10px; background: var(--bg); padding: 0 12px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .input-wrap:focus-within {
      border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft);
    }
    .affix { color: var(--muted); font-weight: 600; }
    input {
      flex: 1; min-width: 0; border: none; background: transparent; color: inherit;
      font: inherit; font-size: 1.05rem; padding: 11px 8px; outline: none;
    }
    input[aria-invalid="true"] { color: var(--danger); }
    .presets { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
    .chip {
      border: 1px solid var(--border); background: var(--bg); color: inherit;
      border-radius: 999px; padding: 6px 14px; font: inherit; font-size: 0.88rem;
      cursor: pointer; transition: background 0.15s, border-color 0.15s;
    }
    .chip:hover { border-color: var(--accent); }
    .chip.active { background: var(--accent); border-color: var(--accent); color: white; }
    .stepper {
      display: flex; align-items: center; border: 1px solid var(--border);
      border-radius: 10px; background: var(--bg); overflow: hidden;
    }
    .stepper:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .stepper input { text-align: center; }
    .step {
      width: 46px; align-self: stretch; border: none; background: transparent;
      color: inherit; font-size: 1.3rem; cursor: pointer;
    }
    .step:hover:not(:disabled) { background: var(--accent-soft); }
    .step:disabled { opacity: 0.35; cursor: not-allowed; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .error { margin: 0; color: var(--danger); font-size: 0.82rem; }
    .results {
      margin-top: 24px; padding: 16px 18px; border-radius: 14px;
      background: var(--accent-soft); display: grid; gap: 8px;
    }
    .row {
      margin: 0; display: flex; justify-content: space-between; gap: 12px;
      color: var(--muted); font-variant-numeric: tabular-nums;
    }
    .row strong { color: var(--text); font-size: 1.05rem; }
    .row.highlight { padding-top: 8px; border-top: 1px solid var(--border); }
    .row.highlight strong { color: var(--accent); font-size: 1.5rem; }
    .reset {
      margin-top: 16px; width: 100%; padding: 11px; border-radius: 10px;
      border: 1px solid var(--border); background: transparent; color: inherit;
      font: inherit; font-weight: 600; cursor: pointer;
    }
    .reset:hover { background: var(--accent-soft); border-color: var(--accent); }
    @media (max-width: 420px) {
      .card { padding: 20px; border-radius: 14px; }
    }
  `,
})
export class App {
  protected readonly presets = [10, 15, 18, 20, 25];

  protected readonly bill = signal('');
  protected readonly tip = signal('15');
  protected readonly people = signal('1');

  protected readonly billInvalid = computed(() => toNumber(this.bill()) < 0);
  protected readonly tipInvalid = computed(() => toNumber(this.tip()) < 0);
  protected readonly peopleInvalid = computed(() => {
    const raw = this.people().trim();
    if (raw === '') return false;
    const n = Number(raw);
    return !Number.isInteger(n) || n < 1;
  });

  protected readonly billValue = computed(() => Math.max(0, toNumber(this.bill())));
  protected readonly tipValue = computed(() => Math.max(0, toNumber(this.tip())));
  protected readonly peopleValue = computed(() => Math.max(1, Math.floor(toNumber(this.people()))));

  protected readonly tipAmount = computed(() => (this.billValue() * this.tipValue()) / 100);
  protected readonly total = computed(() => this.billValue() + this.tipAmount());
  protected readonly perPerson = computed(() => this.total() / this.peopleValue());

  protected asValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected money(n: number): string {
    return '$' + (Math.round(n * 100) / 100).toFixed(2);
  }

  protected adjustPeople(delta: number): void {
    this.people.set(String(Math.max(1, this.peopleValue() + delta)));
  }

  protected reset(): void {
    this.bill.set('');
    this.tip.set('15');
    this.people.set('1');
  }
}
