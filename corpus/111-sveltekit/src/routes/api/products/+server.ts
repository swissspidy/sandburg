import { json } from '@sveltejs/kit';

const DATA = {
  "products": [
    {
      "id": 1,
      "name": "Lamp",
      "price": 25
    },
    {
      "id": 2,
      "name": "Chair",
      "price": 80
    },
    {
      "id": 3,
      "name": "Desk",
      "price": 150
    }
  ]
};

export function GET() {
  return json(DATA);
}
