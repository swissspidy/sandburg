import dayjs from 'dayjs';
const today = dayjs().format('YYYY-MM-DD');
void today;

export function mount(root) {
  const section = document.createElement("section");
  section.setAttribute("aria-label", "Converter");
  section.innerHTML = '<label for="celsius">Celsius</label><input id="celsius" type="number" value="0"><output data-testid="fahrenheit">32.0 \xB0F</output>';
  const input = section.querySelector("input");
  const out = section.querySelector("output");
  input.addEventListener("input", () => {
    out.textContent = (Number(input.value) * 9 / 5 + 32).toFixed(1) + " \xB0F";
  });
  root.append(section);
}
