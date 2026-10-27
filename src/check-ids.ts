/**
 * The ids of a run's functional checks (CheckResult.id): `functional:` and the check's name as a
 * slug, unique within the run.
 */

/**
 * Ids for the functional checks named `names`, in order. A name's slug keeps its letters a-z and
 * digits; a name with none of them ("✓", "添加") is `check-<n>`, its position from 1. Names that
 * make the same slug ("Add item", "add-item") get -2, -3, … after the first.
 */
export function functionalCheckIds(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((name, i) => {
    const base = slug(name) || `check-${i + 1}`;
    let id = base;
    for (let n = 2; seen.has(id); n++) id = `${base}-${n}`;
    seen.add(id);
    return `functional:${id}`;
  });
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
