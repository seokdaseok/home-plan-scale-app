const fs = require('fs');
const path = require('path');

module.exports = (req, res) => {
  const catalogPath = path.join(process.cwd(), 'furniture-catalog.json');
  fs.readFile(catalogPath, 'utf8', (err, data) => {
    if (err) {
      return res.status(500).json({ error: 'Could not load furniture catalog.' });
    }
    try {
      res.json(JSON.parse(data));
    } catch {
      res.status(500).json({ error: 'Catalog file is malformed.' });
    }
  });
};