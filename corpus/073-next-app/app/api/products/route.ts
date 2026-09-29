import { NextResponse } from 'next/server';

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

export async function GET() {
  return NextResponse.json(DATA);
}
