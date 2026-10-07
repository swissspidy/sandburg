const health = await fetch('/api/health').then((r) => r.json());
document.getElementById('sqlite').textContent = `SQLite ${health.sqlite}`;
