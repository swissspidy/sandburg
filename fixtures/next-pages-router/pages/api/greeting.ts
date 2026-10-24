import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(_req: NextApiRequest, res: NextApiResponse<{ message: string }>) {
  res.status(200).json({ message: 'Keep the streak going!' });
}
