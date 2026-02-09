const express = require("express");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcrypt");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const db = require("./db");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

app.use(
  session({
    store: new SQLiteStore({ db: "sessions.sqlite", dir: __dirname }),
    secret: "school-project-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax" },
  })
);

// serve website files
app.use(express.static(path.join(__dirname, "public")));

// --- helpers ---
function requireLogin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ ok: false, error: "Login required" });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ ok: false, error: "Login required" });
  if (!req.session.user.is_admin) return res.status(403).json({ ok: false, error: "Admin required" });
  next();
}
function currentUser(req) {
  return req.session?.user || null;
}
function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// --- health ---
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "Server OK", user: currentUser(req) });
});

// --- AUTH ---
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ ok: false, error: "name, email, password required" });

  const hash = await bcrypt.hash(password, 10);
  const now = Date.now();

  db.get(`SELECT COUNT(*) AS c FROM users WHERE is_admin = 1`, [], (e0, row0) => {
    const makeAdmin = !e0 && (row0?.c || 0) === 0;

    db.run(
      `INSERT INTO users (name, email, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)`,
      [name.trim(), email.trim().toLowerCase(), hash, makeAdmin ? 1 : 0, now],
      function (err) {
        if (err) {
          if (String(err.message || "").includes("UNIQUE")) {
            return res.status(400).json({ ok: false, error: "Email already registered" });
          }
          return res.status(500).json({ ok: false, error: err.message });
        }
        res.json({ ok: true, id: this.lastID, is_admin: makeAdmin });
      }
    );
  });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: "email and password required" });

  db.get(`SELECT id, name, email, password_hash, is_admin FROM users WHERE email = ?`, [email.trim().toLowerCase()], async (err, row) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    if (!row) return res.status(400).json({ ok: false, error: "Invalid login" });

    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(400).json({ ok: false, error: "Invalid login" });

    req.session.user = { id: row.id, name: row.name, email: row.email, is_admin: !!row.is_admin };
    res.json({ ok: true, user: req.session.user });
  });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/auth/me", (req, res) => {
  res.json({ ok: true, user: currentUser(req) });
});

// --- CATEGORIES ---
app.get("/api/categories", (req, res) => {
  db.all(
    `SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != '' ORDER BY category`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, data: rows.map((r) => r.category) });
    }
  );
});

// --- PRODUCTS ---
app.get("/api/products", (req, res) => {
  const q = String(req.query.q || "").trim();
  const min = toNumber(req.query.min_price);
  const max = toNumber(req.query.max_price);
  const category = String(req.query.category || "").trim();

  const where = [];
  const params = [];
  if (q) {
    where.push("(name LIKE ? OR description LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  if (min !== null) {
    where.push("price >= ?");
    params.push(min);
  }
  if (max !== null) {
    where.push("price <= ?");
    params.push(max);
  }
  if (category) {
    where.push("category = ?");
    params.push(category);
  }

  const sql = `SELECT id, name, price, description, image_url, stock, category FROM products${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id DESC`;
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true, data: rows });
  });
});

app.get("/api/products/:id", (req, res) => {
  const pid = Number(req.params.id);
  if (!Number.isFinite(pid)) return res.status(400).json({ ok: false, error: "Invalid id" });
  db.get(`SELECT id, name, price, description, image_url, stock, category FROM products WHERE id = ?`, [pid], (err, row) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    if (!row) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, data: row });
  });
});

app.post("/api/products", requireAdmin, (req, res) => {
  const { name, price, description, image_url, stock, category } = req.body || {};
  const p = toNumber(price);
  const s = toNumber(stock) ?? 0;
  if (!name || p === null) return res.status(400).json({ ok: false, error: "name and price required" });
  const now = Date.now();
  db.run(
    `INSERT INTO products (name, price, description, image_url, stock, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [String(name).trim(), p, description || "", image_url || "", s, category || "", now],
    function (err) {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

app.put("/api/products/:id", requireAdmin, (req, res) => {
  const pid = Number(req.params.id);
  if (!Number.isFinite(pid)) return res.status(400).json({ ok: false, error: "Invalid id" });
  const { name, price, description, image_url, stock, category } = req.body || {};
  const fields = [];
  const params = [];
  if (name !== undefined) {
    fields.push("name = ?");
    params.push(String(name).trim());
  }
  if (price !== undefined) {
    const p = toNumber(price);
    if (p === null) return res.status(400).json({ ok: false, error: "Invalid price" });
    fields.push("price = ?");
    params.push(p);
  }
  if (description !== undefined) {
    fields.push("description = ?");
    params.push(String(description));
  }
  if (image_url !== undefined) {
    fields.push("image_url = ?");
    params.push(String(image_url));
  }
  if (stock !== undefined) {
    const s = toNumber(stock);
    if (s === null) return res.status(400).json({ ok: false, error: "Invalid stock" });
    fields.push("stock = ?");
    params.push(s);
  }
  if (category !== undefined) {
    fields.push("category = ?");
    params.push(String(category));
  }
  if (!fields.length) return res.status(400).json({ ok: false, error: "No fields to update" });

  params.push(pid);
  db.run(`UPDATE products SET ${fields.join(", ")} WHERE id = ?`, params, function (err) {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true, updated: this.changes });
  });
});

app.delete("/api/products/:id", requireAdmin, (req, res) => {
  const pid = Number(req.params.id);
  if (!Number.isFinite(pid)) return res.status(400).json({ ok: false, error: "Invalid id" });
  db.run(`DELETE FROM products WHERE id = ?`, [pid], function (err) {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true, deleted: this.changes });
  });
});

// --- CART (requires login) ---
app.get("/api/cart", requireLogin, (req, res) => {
  const uid = req.session.user.id;
  db.all(
    `
    SELECT ci.product_id AS id, p.name, p.price, p.description, p.category, p.stock, p.image_url, ci.qty
    FROM cart_items ci
    JOIN products p ON p.id = ci.product_id
    WHERE ci.user_id = ?
    ORDER BY p.id DESC
    `,
    [uid],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      const total = rows.reduce((s, r) => s + Number(r.price) * Number(r.qty), 0);
      res.json({ ok: true, data: rows, total });
    }
  );
});

app.post("/api/cart/add", requireLogin, (req, res) => {
  const uid = req.session.user.id;
  const { product_id, qty } = req.body || {};
  const pid = Number(product_id);
  const q = Number(qty || 1);

  if (!Number.isFinite(pid) || pid <= 0) return res.status(400).json({ ok: false, error: "Invalid product_id" });
  if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ ok: false, error: "Invalid qty" });

  db.run(
    `
    INSERT INTO cart_items (user_id, product_id, qty)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, product_id) DO UPDATE SET qty = qty + excluded.qty
    `,
    [uid, pid, q],
    (err) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true });
    }
  );
});

app.post("/api/cart/update", requireLogin, (req, res) => {
  const uid = req.session.user.id;
  const { items } = req.body || {}; // [{product_id, qty}]
  if (!Array.isArray(items)) return res.status(400).json({ ok: false, error: "items[] required" });

  db.serialize(() => {
    const upd = db.prepare(`UPDATE cart_items SET qty = ? WHERE user_id = ? AND product_id = ?`);
    const del = db.prepare(`DELETE FROM cart_items WHERE user_id = ? AND product_id = ?`);

    items.forEach((it) => {
      const pid = Number(it.product_id);
      const q = Number(it.qty);
      if (!Number.isFinite(pid) || pid <= 0) return;
      if (!Number.isFinite(q) || q <= 0) del.run(uid, pid);
      else upd.run(q, uid, pid);
    });

    upd.finalize();
    del.finalize();

    res.json({ ok: true });
  });
});

app.post("/api/cart/clear", requireLogin, (req, res) => {
  const uid = req.session.user.id;
  db.run(`DELETE FROM cart_items WHERE user_id = ?`, [uid], (err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true });
  });
});

// --- WISHLIST (requires login) ---
app.get("/api/wishlist", requireLogin, (req, res) => {
  const uid = req.session.user.id;
  db.all(
    `
    SELECT w.product_id AS id, p.name, p.price, p.description, p.image_url, p.category, p.stock
    FROM wishlist_items w
    JOIN products p ON p.id = w.product_id
    WHERE w.user_id = ?
    ORDER BY p.id DESC
    `,
    [uid],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, data: rows });
    }
  );
});

app.post("/api/wishlist/add", requireLogin, (req, res) => {
  const uid = req.session.user.id;
  const pid = Number(req.body?.product_id);
  if (!Number.isFinite(pid) || pid <= 0) return res.status(400).json({ ok: false, error: "Invalid product_id" });

  db.run(
    `
    INSERT INTO wishlist_items (user_id, product_id)
    VALUES (?, ?)
    ON CONFLICT(user_id, product_id) DO NOTHING
    `,
    [uid, pid],
    (err) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true });
    }
  );
});

app.post("/api/wishlist/remove", requireLogin, (req, res) => {
  const uid = req.session.user.id;
  const pid = Number(req.body?.product_id);
  if (!Number.isFinite(pid) || pid <= 0) return res.status(400).json({ ok: false, error: "Invalid product_id" });

  db.run(`DELETE FROM wishlist_items WHERE user_id = ? AND product_id = ?`, [uid, pid], (err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true });
  });
});

// --- PROMO ---
app.post("/api/promo/validate", requireLogin, (req, res) => {
  const code = String(req.body?.code || "").trim();
  const subtotal = toNumber(req.body?.subtotal) || 0;
  if (!code) return res.status(400).json({ ok: false, error: "code required" });

  db.get(`SELECT code, type, value, active FROM promo_codes WHERE code = ? COLLATE NOCASE`, [code], (err, row) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    if (!row || !row.active) return res.status(404).json({ ok: false, error: "Invalid code" });

    let discount = 0;
    if (row.type === "PERCENT") discount = (subtotal * Number(row.value)) / 100;
    else discount = Number(row.value);

    discount = Math.max(0, Math.min(subtotal, discount));
    res.json({ ok: true, promo: row.code, type: row.type, value: row.value, discount });
  });
});

// --- CHECKOUT (requires login) ---
app.post("/api/checkout", requireLogin, (req, res) => {
  const uid = req.session.user.id;
  const { promo_code, shipping_name, shipping_address, shipping_phone } = req.body || {};

  if (!shipping_name || !shipping_address || !shipping_phone) {
    return res.status(400).json({ ok: false, error: "Shipping info required" });
  }

  db.all(
    `
    SELECT ci.product_id, ci.qty, p.price
    FROM cart_items ci
    JOIN products p ON p.id = ci.product_id
    WHERE ci.user_id = ?
    `,
    [uid],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      if (!rows.length) return res.status(400).json({ ok: false, error: "Cart is empty" });

      const subtotal = rows.reduce((s, r) => s + Number(r.price) * Number(r.qty), 0);

      const finishCheckout = (promoRow) => {
        let discount = 0;
        let promo = null;

        if (promoRow && promoRow.active) {
          promo = promoRow.code;
          if (promoRow.type === "PERCENT") discount = (subtotal * Number(promoRow.value)) / 100;
          else discount = Number(promoRow.value);
          discount = Math.max(0, Math.min(subtotal, discount));
        }

        const total = subtotal - discount;
        const now = Date.now();

        db.run(
          `INSERT INTO orders (user_id, total, status, promo_code, discount, shipping_name, shipping_address, shipping_phone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [uid, total, "PENDING", promo, discount, String(shipping_name), String(shipping_address), String(shipping_phone), now],
          function (e2) {
            if (e2) return res.status(500).json({ ok: false, error: e2.message });
            const orderId = this.lastID;

            db.serialize(() => {
              const stmt = db.prepare(`INSERT INTO order_items (order_id, product_id, qty, price_each) VALUES (?, ?, ?, ?)`);
              rows.forEach((r) => stmt.run(orderId, r.product_id, r.qty, r.price));
              stmt.finalize();

              db.run(`DELETE FROM cart_items WHERE user_id = ?`, [uid], (e3) => {
                if (e3) return res.status(500).json({ ok: false, error: e3.message });
                console.log("Checkout complete", { orderId, userId: uid, total, promo, discount });
                res.json({ ok: true, order_id: orderId, subtotal, discount, total });
              });
            });
          }
        );
      };

      const code = String(promo_code || "").trim();
      if (!code) return finishCheckout(null);

      db.get(`SELECT code, type, value, active FROM promo_codes WHERE code = ? COLLATE NOCASE`, [code], (e0, row0) => {
        if (e0) return res.status(500).json({ ok: false, error: e0.message });
        if (!row0 || !row0.active) return res.status(400).json({ ok: false, error: "Invalid promo" });
        finishCheckout(row0);
      });
    }
  );
});

// --- ORDERS (requires login) ---
app.get("/api/orders", requireLogin, (req, res) => {
  const uid = req.session.user.id;
  db.all(
    `SELECT id, total, status, promo_code, discount, shipping_name, shipping_address, shipping_phone, created_at FROM orders WHERE user_id = ? ORDER BY id DESC`,
    [uid],
    (err, orders) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, data: orders });
    }
  );
});

app.get("/api/orders/:id", requireLogin, (req, res) => {
  const uid = req.session.user.id;
  const oid = Number(req.params.id);
  if (!Number.isFinite(oid)) return res.status(400).json({ ok: false, error: "Invalid id" });

  db.get(
    `SELECT id, total, status, promo_code, discount, shipping_name, shipping_address, shipping_phone, created_at FROM orders WHERE id = ? AND user_id = ?`,
    [oid, uid],
    (err, order) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      if (!order) return res.status(404).json({ ok: false, error: "Not found" });
      res.json({ ok: true, data: order });
    }
  );
});

app.get("/api/orders/:id/items", requireLogin, (req, res) => {
  const uid = req.session.user.id;
  const oid = Number(req.params.id);

  db.get(`SELECT id FROM orders WHERE id = ? AND user_id = ?`, [oid, uid], (e0, okRow) => {
    if (e0) return res.status(500).json({ ok: false, error: e0.message });
    if (!okRow) return res.status(404).json({ ok: false, error: "Not found" });

    db.all(
      `
      SELECT oi.qty, oi.price_each, p.name
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?
      `,
      [oid],
      (err, items) => {
        if (err) return res.status(500).json({ ok: false, error: err.message });
        res.json({ ok: true, data: items });
      }
    );
  });
});

// --- ADMIN ---
app.get("/api/admin/orders", requireAdmin, (req, res) => {
  db.all(
    `
    SELECT o.id, o.total, o.status, o.promo_code, o.discount, o.shipping_name, o.shipping_address, o.shipping_phone, o.created_at,
           u.name AS user_name, u.email AS user_email
    FROM orders o
    JOIN users u ON u.id = o.user_id
    ORDER BY o.id DESC
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, data: rows });
    }
  );
});

app.post("/api/orders/:id/status", requireAdmin, (req, res) => {
  const oid = Number(req.params.id);
  const status = String(req.body?.status || "").trim().toUpperCase();
  const allowed = ["PENDING", "PAID", "SHIPPED", "DELIVERED", "CANCELLED"];
  if (!Number.isFinite(oid)) return res.status(400).json({ ok: false, error: "Invalid id" });
  if (!allowed.includes(status)) return res.status(400).json({ ok: false, error: "Invalid status" });

  db.run(`UPDATE orders SET status = ? WHERE id = ?`, [status, oid], function (err) {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true, updated: this.changes });
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
