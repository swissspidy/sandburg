import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';

const budget: number = 'unlimited';
void budget;

export default function Pages() {
  return (
    <BrowserRouter>
      <nav aria-label="Site">
        <Link to="/">Home</Link> <Link to="/about">About</Link>
      </nav>
      <Routes>
        <Route path="/" element={<h2>Welcome home</h2>} />
        <Route path="/about" element={<h2>About us</h2>} />
        <Route path="*" element={<h2>Not found</h2>} />
      </Routes>
    </BrowserRouter>
  );
}
