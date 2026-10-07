'use client';

import { useId, useState } from 'react';

const PRESETS = [10, 15, 18, 20, 25];

function toNumber(value) {
  if (value === '' || value === null || value === undefined) return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function money(n) {
  const rounded = Math.round((n + Number.EPSILON) * 100) / 100;
  return '$' + rounded.toFixed(2);
}

export default function TipCalculator() {
  const [bill, setBill] = useState('');
  const [percent, setPercent] = useState('15');
  const [people, setPeople] = useState('1');
  const [roundUp, setRoundUp] = useState(false);
  const ids = {
    bill: useId(),
    percent: useId(),
    people: useId(),
    peopleHint: useId(),
    roundUp: useId(),
  };

  const billNum = toNumber(bill);
  const percentNum = toNumber(percent);
  const peopleNum = toNumber(people);

  const safeBill = Number.isNaN(billNum) || billNum < 0 ? 0 : billNum;
  const safePercent = Number.isNaN(percentNum) || percentNum < 0 ? 0 : percentNum;
  const peopleValid = !Number.isNaN(peopleNum) && peopleNum >= 1;
  const safePeople = peopleValid ? Math.floor(peopleNum) : 1;

  // Work in cents to avoid floating-point surprises.
  const billCents = Math.round(safeBill * 100);
  const baseTipCents = Math.round((safeBill * safePercent) / 100 * 100);
  let totalCents = billCents + baseTipCents;
  if (roundUp) {
    totalCents = Math.ceil(totalCents / 100) * 100;
  }
  const tipCents = totalCents - billCents;

  const tip = tipCents / 100;
  const total = totalCents / 100;
  const perPerson = total / safePeople;

  const hasBill = safeBill > 0;

  return (
    <section className="card" aria-labelledby="calc-title">
      <header className="card-header">
        <span className="logo" aria-hidden="true">💸</span>
        <div>
          <h1 id="calc-title">Tip calculator</h1>
          <p className="subtitle">Split the bill without the math.</p>
        </div>
      </header>

      <div className="grid">
        <form className="inputs" onSubmit={(e) => e.preventDefault()}>
          <div className="field">
            <label htmlFor={ids.bill}>Bill amount</label>
            <div className="input-wrap">
              <span className="affix" aria-hidden="true">$</span>
              <input
                id={ids.bill}
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={bill}
                onChange={(e) => setBill(e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor={ids.percent}>Tip percent</label>
            <div className="input-wrap">
              <input
                id={ids.percent}
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                placeholder="15"
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
              />
              <span className="affix" aria-hidden="true">%</span>
            </div>
            <div className="presets" role="group" aria-label="Quick tip percentages">
              {PRESETS.map((p) => {
                const active = percentNum === p;
                return (
                  <button
                    key={p}
                    type="button"
                    className={active ? 'preset active' : 'preset'}
                    aria-pressed={active}
                    aria-label={`Set tip to ${p} percent`}
                    onClick={() => setPercent(String(p))}
                  >
                    {p}%
                  </button>
                );
              })}
            </div>
          </div>

          <div className="field">
            <label htmlFor={ids.people}>People</label>
            <div className="input-wrap">
              <span className="affix" aria-hidden="true">👥</span>
              <input
                id={ids.people}
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                value={people}
                aria-invalid={!peopleValid}
                aria-describedby={!peopleValid ? ids.peopleHint : undefined}
                onChange={(e) => setPeople(e.target.value)}
              />
            </div>
            {!peopleValid && (
              <p id={ids.peopleHint} className="hint">
                Enter at least 1 person — splitting as 1 for now.
              </p>
            )}
          </div>

          <div className="checkbox-field">
            <input
              id={ids.roundUp}
              type="checkbox"
              checked={roundUp}
              onChange={(e) => setRoundUp(e.target.checked)}
            />
            <label htmlFor={ids.roundUp}>Round up</label>
          </div>

          <button
            type="button"
            className="reset"
            onClick={() => {
              setBill('');
              setPercent('15');
              setPeople('1');
              setRoundUp(false);
            }}
          >
            Reset
          </button>
        </form>

        <div className="results" aria-live="polite" aria-label="Results">
          {!hasBill && (
            <p className="empty">Enter a bill amount to see the tip and split.</p>
          )}
          <p className="row">
            <span className="label">Tip:</span> <span className="value">{money(tip)}</span>
          </p>
          <p className="row">
            <span className="label">Total:</span> <span className="value">{money(total)}</span>
          </p>
          <p className="row highlight">
            <span className="label">Per person:</span>{' '}
            <span className="value">{money(perPerson)}</span>
          </p>
          {roundUp && hasBill && (
            <p className="note">Total rounded up to the next whole dollar.</p>
          )}
        </div>
      </div>
    </section>
  );
}
