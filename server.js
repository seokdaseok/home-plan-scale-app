const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Explicit routes FIRST (before static middleware) ───────────────────────

// Landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// App
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API: Furniture catalog
app.get('/api/furniture-catalog', (req, res) => {
  const catalogPath = path.join(__dirname, 'furniture-catalog.json');
  fs.readFile(catalogPath, 'utf8', (err, data) => {
    if (err) {
      console.error('Could not read furniture-catalog.json:', err.message);
      return res.status(500).json({ error: 'Could not load furniture catalog.' });
    }
    try {
      res.json(JSON.parse(data));
    } catch (parseErr) {
      console.error('furniture-catalog.json is not valid JSON:', parseErr.message);
      res.status(500).json({ error: 'Catalog file is malformed.' });
    }
  });
});

// ── Static assets AFTER routes (css, js, images etc.) ─────────────────────
// express.static won't intercept / anymore since the route above catches it first
app.use(express.static(path.join(__dirname, 'public')));

// ── Start ──────────────────────────────────────────────────────────────────
// app.listen(PORT, () => {
//   console.log(`\n  Plan/Scale running at http://localhost:${PORT}`);
//   console.log(`  Landing: http://localhost:${PORT}/`);
//   console.log(`  App:     http://localhost:${PORT}/app\n`);
// });

module.exports = app;