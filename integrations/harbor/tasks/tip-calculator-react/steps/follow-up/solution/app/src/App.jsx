import { useId, useState } from 'react';

const PRESETS = [10, 15, 18, 20, 25];

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function money(n) {
  return `$${round2(n).toFixed(2)}`;
}

function parseNum(value) {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

export default function App() {
  const [bill, setBill] = useState('');
  const [tipPct, setTipPct] = useState('');
  const [people, setPeople] = useState('1');
  const [roundUp, setRoundUp] = useState(false);
  const ids = { bill: useId(), tip: useId(), people: useId(), round: useId() };

  const billN = parseNum(bill);
  const tipN = parseNum(tipPct);
  const peopleN = parseNum(people);

  const billError = billN !== null && (Number.isNaN(billN) || billN < 0) ? 'Enter a bill of 0 or more.' : '';
  const tipError = tipN !== null && (Number.isNaN(tipN) || tipN < 0) ? 'Enter a tip of 0% or more.' : '';
  const peopleError =
    peopleN !== null && (Number.isNaN(peopleN) || peopleN < 1 || !Number.isInteger(peopleN))
      ? 'Enter a whole number of 1 or more.'
      : '';

  const b = billN && !billError ? billN : 0;
  const t = tipN && !tipError ? tipN : 0;
  const p = peopleN && !peopleError ? peopleN : 1;

  const baseTip = (b * t) / 100;
  const baseTotal = round2(b + baseTip);
  const total = roundUp ? Math.ceil(baseTotal) : baseTotal;
  const tip = roundUp ? total - b : baseTip;
  const perPerson = total / p;
  const roundedExtra = round2(total - baseTotal);

  const reset = () => {
    setBill('');
    setTipPct('');
    setPeople('1');
    setRoundUp(false);
  };

  return (
    <main className="page">
      <section className="card" aria-labelledby="title">
        <header className="card-head">
          <span className="logo" aria-hidden="true">🧾</span>
          <div>
            <h1 id="title">Tip Calculator</h1>
            <p className="sub">Split the bill fairly, in seconds.</p>
          </div>
        </header>

        <div className="grid">
          <form className="inputs" onSubmit={(e) => e.preventDefault()} noValidate>
            <div className="field">
              <label htmlFor={ids.bill}>Bill amount</label>
              <div className={`control ${billError ? 'invalid' : ''}`}>
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
                  aria-invalid={!!billError}
                  aria-describedby={billError ? `${ids.bill}-err` : undefined}
                />
              </div>
              {billError && <p className="error" id={`${ids.bill}-err`}>{billError}</p>}
            </div>

            <div className="field">
              <label htmlFor={ids.tip}>Tip percent</label>
              <div className={`control ${tipError ? 'invalid' : ''}`}>
                <input
                  id={ids.tip}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="1"
                  placeholder="15"
                  value={tipPct}
                  onChange={(e) => setTipPct(e.target.value)}
                  aria-invalid={!!tipError}
                  aria-describedby={tipError ? `${ids.tip}-err` : undefined}
                />
                <span className="affix" aria-hidden="true">%</span>
              </div>
              <div className="presets" role="group" aria-label="Tip presets">
                {PRESETS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`chip ${tipN === n ? 'active' : ''}`}
                    aria-pressed={tipN === n}
                    aria-label={`Set tip to ${n}%`}
                    onClick={() => setTipPct(String(n))}
                  >
                    {n}%
                  </button>
                ))}
              </div>
              {tipError && <p className="error" id={`${ids.tip}-err`}>{tipError}</p>}
            </div>

            <div className="field">
              <label htmlFor={ids.people}>People</label>
              <div className={`control ${peopleError ? 'invalid' : ''}`}>
                <span className="affix" aria-hidden="true">👥</span>
                <input
                  id={ids.people}
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  value={people}
                  onChange={(e) => setPeople(e.target.value)}
                  aria-invalid={!!peopleError}
                  aria-describedby={peopleError ? `${ids.people}-err` : undefined}
                />
              </div>
              {peopleError && <p className="error" id={`${ids.people}-err`}>{peopleError}</p>}
            </div>

            <div className="checkbox-field">
              <input
                id={ids.round}
                type="checkbox"
                checked={roundUp}
                onChange={(e) => setRoundUp(e.target.checked)}
              />
              <label htmlFor={ids.round}>Round up</label>
              <span className="checkbox-hint">to the next whole dollar</span>
            </div>
          </form>

          <section className="results" aria-labelledby="results-title">
            <h2 id="results-title" className="visually-hidden">Results</h2>
            <dl aria-live="polite">
              <div className="row">
                <dt>Tip</dt>
                <dd>
                  <span data-testid="tip">{`Tip: ${money(tip)}`}</span>
                </dd>
              </div>
              <div className="row">
                <dt>Total</dt>
                <dd>
                  <span data-testid="total">{`Total: ${money(total)}`}</span>
                  {roundUp && roundedExtra > 0 && (
                    <span className="note">+{money(roundedExtra)} rounded</span>
                  )}
                </dd>
              </div>
              <div className="row highlight">
                <dt>Per person</dt>
                <dd>
                  <span data-testid="per-person">{`Per person: ${money(perPerson)}`}</span>
                </dd>
              </div>
            </dl>
            {b === 0 && <p className="hint">Enter a bill amount to get started.</p>}
            <button type="button" className="reset" onClick={reset}>
              Reset
            </button>
          </section>
        </div>
      </section>
    </main>
  );
}
