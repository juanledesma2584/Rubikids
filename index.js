const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json());

// Base de datos SQLite local
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (!err) {
    console.log('Base de datos conectada.');
    inicializarBD();
  }
});

function inicializarBD() {
  db.serialize(() => {
    // Tabla de inventario
    db.run(`CREATE TABLE IF NOT EXISTS productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT,
      precio REAL,
      costo REAL,
      stock INTEGER
    )`);

    // Tabla de ventas
    db.run(`CREATE TABLE IF NOT EXISTS ventas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monto_total REAL,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tabla de aforo/ingreso de personas
    db.run(`CREATE TABLE IF NOT EXISTS aforo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cantidad INTEGER,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Cargar producto de prueba si la tabla está vacía
    db.get('SELECT COUNT(*) as count FROM productos', (err, row) => {
      if (row && row.count === 0) {
        db.run('INSERT INTO productos (nombre, precio, costo, stock) VALUES (?, ?, ?, ?)', 
          ['Entrada General', 50.00, 10.00, 100]);
      }
    });
  });
}

// Middleware para verificar rol
function verificarRol(rolRequerido) {
  return (req, res, next) => {
    const rolUsuario = req.headers['x-rol'];
    if (rolUsuario === rolRequerido || rolUsuario === 'dueno') {
      next();
    } else {
      res.status(403).json({ error: 'Acceso denegado: Se requieren permisos de Administrador' });
    }
  };
}

// -------------------------------------------------------------
// ENDPOINTS DE LA API
// -------------------------------------------------------------

// PERSONAL: Ver stock disponible (sin costos de compra)
app.get('/api/personal/inventario', (req, res) => {
  db.all('SELECT id, nombre, precio, stock FROM productos', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// PERSONAL: Realizar cobro y descontar stock
app.post('/api/personal/cobrar', (req, res) => {
  const { productoId, cantidad } = req.body;

  db.get('SELECT precio, stock FROM productos WHERE id = ?', [productoId], (err, producto) => {
    if (err || !producto) return res.status(400).json({ error: 'Producto no encontrado' });
    if (producto.stock < cantidad) return res.status(400).json({ error: 'Stock insuficiente' });

    const total = producto.precio * cantidad;

    db.run('UPDATE productos SET stock = stock - ? WHERE id = ?', [cantidad, productoId], function(err) {
      if (err) return res.status(500).json({ error: err.message });

      db.run('INSERT INTO ventas (monto_total) VALUES (?)', [total], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ mensaje: 'Cobro registrado correctamente', total });
      });
    });
  });
});

// PERSONAL: Registrar ingreso de personas (Aforo)
app.post('/api/personal/aforo', (req, res) => {
  const { personas } = req.body;
  db.run('INSERT INTO aforo (cantidad) VALUES (?)', [personas], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ mensaje: 'Aforo registrado correctamente' });
  });
});

// DUEÑO: Balance total de ventas y costos (Protegido)
app.get('/api/dueno/balance', verificarRol('dueno'), (req, res) => {
  const sql = `
    SELECT 
      (SELECT SUM(monto_total) FROM ventas) as total_ventas,
      (SELECT SUM(cantidad) FROM aforo) as total_personas,
      (SELECT SUM(stock * costo) FROM productos) as valor_inventario_costo
  `;
  db.get(sql, [], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({
      totalVentas: row ? (row.total_ventas || 0) : 0,
      totalPersonasIngresadas: row ? (row.total_personas || 0) : 0,
      valorStockEnCosto: row ? (row.valor_inventario_costo || 0) : 0
    });
  });
});

// DUEÑO: Agregar/Ajustar stock (Protegido)
app.post('/api/dueno/producto', verificarRol('dueno'), (req, res) => {
  const { nombre, precio, costo, stock } = req.body;
  db.run('INSERT INTO productos (nombre, precio, costo, stock) VALUES (?, ?, ?, ?)', 
    [nombre, precio, costo, stock], 
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ mensaje: 'Producto o stock agregado', id: this.lastID });
    }
  );
});

// -------------------------------------------------------------
// INTERFAZ WEB MINIMALISTA
// -------------------------------------------------------------
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>Sistema POS Demo</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f4f4f9; }
        .box { background: white; padding: 15px; margin-bottom: 20px; border-radius: 5px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        h2 { margin-top: 0; }
        button { padding: 8px 12px; cursor: pointer; background: #007bff; color: white; border: none; border-radius: 4px; }
        input { padding: 8px; margin-right: 5px; }
        .danger { background: #dc3545; }
      </style>
    </head>
    <body>

      <h1>Punto de Venta - Panel General</h1>

      <!-- VISTA DEL PERSONAL -->
      <div class="box">
        <h2>1. Vista Personal (Cobros y Aforo)</h2>
        <button onclick="cargarInventario()">Cargar Inventario</button>
        <ul id="lista-inventario"></ul>

        <h3>Cobrar a Cliente</h3>
        <input type="number" id="prod-id" placeholder="ID Producto" value="1">
        <input type="number" id="prod-cant" placeholder="Cantidad" value="1">
        <button onclick="realizarCobro()">Registrar Cobro</button>

        <h3>Registrar Ingreso de Personas</h3>
        <input type="number" id="cant-personas" placeholder="Cantidad de personas" value="1">
        <button onclick="registrarAforo()">Registrar Ingreso</button>
      </div>

      <!-- VISTA EXCLUSIVA DEL DUEÑO -->
      <div class="box">
        <h2>2. Vista Exclusiva Propietario (Balance)</h2>
        <button class="danger" onclick="consultarBalance()">Ver Balance General</button>
        <pre id="resultado-balance" style="margin-top: 10px; background: #eee; padding: 10px;"></pre>
      </div>

      <script>
        async function cargarInventario() {
          const res = await fetch('/api/personal/inventario');
          const data = await res.json();
          const lista = document.getElementById('lista-inventario');
          lista.innerHTML = '';
          data.forEach(p => {
            lista.innerHTML += \`<li>ID: \${p.id} | \${p.nombre} - Precio: $\${p.precio} | Stock: \${p.stock}</li>\`;
          });
        }

        async function realizarCobro() {
          const productoId = document.getElementById('prod-id').value;
          const cantidad = document.getElementById('prod-cant').value;
          const res = await fetch('/api/personal/cobrar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productoId, cantidad })
          });
          const data = await res.json();
          alert(data.mensaje || data.error);
          cargarInventario();
        }

        async function registrarAforo() {
          const personas = document.getElementById('cant-personas').value;
          const res = await fetch('/api/personal/aforo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ personas })
          });
          const data = await res.json();
          alert(data.mensaje || data.error);
        }

        async function consultarBalance() {
          const res = await fetch('/api/dueno/balance', {
            headers: { 'x-rol': 'dueno' }
          });
          const data = await res.json();
          document.getElementById('resultado-balance').innerText = JSON.stringify(data, null, 2);
        }
      </script>

    </body>
    </html>
  `);
});

// Iniciar servidor
const PORT = 3000;
app.listen(PORT, () => console.log(`Servidor iniciado en http://localhost:${PORT}`));
