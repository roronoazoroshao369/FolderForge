import { Calculator, TAX_RATE } from './calculator.js';

export function main(): number {
  const c = new Calculator().add(10).subtract(3);
  return Math.round(c.result() * (1 + TAX_RATE));
}

if (import.meta.url === `file://${process.argv[1]}`) {

  console.log(`result=${main()}`);
}
