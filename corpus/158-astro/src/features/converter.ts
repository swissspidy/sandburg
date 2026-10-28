export function mount(root: HTMLElement) {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Converter');
  section.innerHTML = '<label for="celsius">Celsius</label><input id="celsius" type="number" value="0"><output data-testid="fahrenheit">32.0 °F</output>';
  const input = section.querySelector('input')!;
  const out = section.querySelector('output')!;
  input.addEventListener('input', () => { out.textContent = ((Number(input.value) * 9) / 5 + 32).toFixed(1) + ' °F'; });
  root.append(section);
}
