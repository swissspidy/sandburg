import type { NextApiRequest, NextApiResponse } from 'next';

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

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json(DATA);
}
