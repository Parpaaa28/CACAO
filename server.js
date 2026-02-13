const express = require("express");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcrypt");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

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
function requireAdminRole(role) {
  return (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ ok: false, error: "Login required" });
    if (!req.session.user.is_admin) return res.status(403).json({ ok: false, error: "Admin required" });
    const userRole = req.session.user.role || "admin";
    if (userRole !== role) return res.status(403).json({ ok: false, error: "Insufficient role" });
    next();
  };
}
function currentUser(req) {
  return req.session?.user || null;
}
function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function logActivity(req, action, meta) {
  const userId = req.session?.user?.id || null;
  const now = Date.now();
  db.run(
    `INSERT INTO activity_log (user_id, action, meta, created_at) VALUES (?, ?, ?, ?)`,
    [userId, action, meta ? JSON.stringify(meta) : null, now]
  );
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

    const role = makeAdmin ? "admin" : "customer";
    db.run(
      `INSERT INTO users (name, email, password_hash, is_admin, role, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [name.trim(), email.trim().toLowerCase(), hash, makeAdmin ? 1 : 0, role, now],
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

  db.get(`SELECT id, name, email, password_hash, is_admin, is_active, role FROM users WHERE email = ?`, [email.trim().toLowerCase()], async (err, row) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    if (!row) return res.status(400).json({ ok: false, error: "Invalid login" });
    if (row.is_active === 0) return res.status(403).json({ ok: false, error: "Account disabled" });

    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(400).json({ ok: false, error: "Invalid login" });

    req.session.user = {
      id: row.id,
      name: row.name,
      email: row.email,
      is_admin: !!row.is_admin,
      role: row.role || (row.is_admin ? "admin" : "customer")
    };
    res.json({ ok: true, user: req.session.user });
  });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/auth/me", (req, res) => {
  const user = currentUser(req);
  if (user && !user.role) {
    user.role = user.is_admin ? "admin" : "customer";
    req.session.user = user;
  }
  res.json({ ok: true, user });
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

// --- SITE SETTINGS (public) ---
app.get("/api/settings", (req, res) => {
  db.all(`SELECT key, value FROM site_settings`, [], (err, rows) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    const out = {};
    rows.forEach((r) => {
      const key = r.key;
      let val = r.value;
      try {
        if (typeof val === "string" && (val.startsWith("[") || val.startsWith("{"))) {
          val = JSON.parse(val);
        }
      } catch (e) {}
      out[key] = val;
    });
    res.json({ ok: true, data: out });
  });
});

// --- SHIPPING ZONES (public) ---
app.get("/api/shipping-zones", (req, res) => {
  db.all(
    `SELECT id, name, fee, eta_text FROM shipping_zones WHERE active = 1 ORDER BY id ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, data: rows });
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

  const sql = `SELECT id, name, price, description, image_url, stock, category, tag_best_seller, tag_new, tag_limited FROM products${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id DESC`;
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true, data: rows });
  });
});

app.get("/api/products/:id", (req, res) => {
  const pid = Number(req.params.id);
  if (!Number.isFinite(pid)) return res.status(400).json({ ok: false, error: "Invalid id" });
  db.get(`SELECT id, name, price, description, image_url, stock, category, tag_best_seller, tag_new, tag_limited FROM products WHERE id = ?`, [pid], (err, row) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    if (!row) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, data: row });
  });
});

app.post("/api/products", requireAdminRole("admin"), (req, res) => {
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
      logActivity(req, "product_create", { id: this.lastID, name, price: p, stock: s });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

app.put("/api/products/:id", requireAdminRole("admin"), (req, res) => {
  const pid = Number(req.params.id);
  if (!Number.isFinite(pid)) return res.status(400).json({ ok: false, error: "Invalid id" });
  const { name, price, description, image_url, stock, category, tag_best_seller, tag_new, tag_limited } = req.body || {};
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
  if (tag_best_seller !== undefined) {
    fields.push("tag_best_seller = ?");
    params.push(tag_best_seller ? 1 : 0);
  }
  if (tag_new !== undefined) {
    fields.push("tag_new = ?");
    params.push(tag_new ? 1 : 0);
  }
  if (tag_limited !== undefined) {
    fields.push("tag_limited = ?");
    params.push(tag_limited ? 1 : 0);
  }
  if (!fields.length) return res.status(400).json({ ok: false, error: "No fields to update" });

  params.push(pid);
  db.run(`UPDATE products SET ${fields.join(", ")} WHERE id = ?`, params, function (err) {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    logActivity(req, "product_update", { id: pid, fields: Object.keys(req.body || {}) });
    res.json({ ok: true, updated: this.changes });
  });
});

app.delete("/api/products/:id", requireAdminRole("admin"), (req, res) => {
  const pid = Number(req.params.id);
  if (!Number.isFinite(pid)) return res.status(400).json({ ok: false, error: "Invalid id" });
  db.run(`DELETE FROM products WHERE id = ?`, [pid], function (err) {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    logActivity(req, "product_delete", { id: pid });
    res.json({ ok: true, deleted: this.changes });
  });
});

app.post("/api/admin/products/stock", requireAdmin, (req, res) => {
  const { id, stock } = req.body || {};
  const pid = Number(id);
  const s = toNumber(stock);
  if (!Number.isFinite(pid) || s === null) return res.status(400).json({ ok: false, error: "id and stock required" });
  db.run(`UPDATE products SET stock = ? WHERE id = ?`, [s, pid], function (err) {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    logActivity(req, "product_stock_update", { id: pid, stock: s });
    res.json({ ok: true, updated: this.changes });
  });
});

app.post("/api/admin/products/stock-bulk", requireAdmin, (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, error: "items[] required" });
  db.serialize(() => {
    const stmt = db.prepare(`UPDATE products SET stock = ? WHERE id = ?`);
    const stmtByName = db.prepare(`UPDATE products SET stock = ? WHERE name = ?`);
    let count = 0;
    items.forEach((it) => {
      const pid = Number(it.id);
      const s = toNumber(it.stock);
      if (s === null) return;
      if (Number.isFinite(pid)) {
        stmt.run(s, pid);
        count += 1;
        return;
      }
      const name = String(it.name || "").trim();
      if (!name) return;
      stmtByName.run(s, name);
      count += 1;
    });
    stmt.finalize();
    stmtByName.finalize();
    logActivity(req, "product_stock_bulk", { count });
    res.json({ ok: true, updated: count });
  });
});

app.post("/api/admin/products/bulk", requireAdminRole("admin"), (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, error: "items[] required" });
  const now = Date.now();
  db.serialize(() => {
    let count = 0;
    items.forEach((p) => {
      const name = String(p.name || "").trim();
      const price = toNumber(p.price);
      if (!name || price === null) return;
      const stock = toNumber(p.stock) ?? 0;
      const description = String(p.description || "");
      const image_url = String(p.image_url || "");
      const category = String(p.category || "");
      const tag_best_seller = Number(p.tag_best_seller) ? 1 : 0;
      const tag_new = Number(p.tag_new) ? 1 : 0;
      const tag_limited = Number(p.tag_limited) ? 1 : 0;
      db.run(
        `INSERT INTO products (name, price, description, image_url, stock, category, tag_best_seller, tag_new, tag_limited, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, price, description, image_url, stock, category, tag_best_seller, tag_new, tag_limited, now]
      );
      db.run(
        `UPDATE products
         SET price = ?, description = ?, image_url = ?, stock = ?, category = ?, tag_best_seller = ?, tag_new = ?, tag_limited = ?
         WHERE name = ?`,
        [price, description, image_url, stock, category, tag_best_seller, tag_new, tag_limited, name]
      );
      count += 1;
    });
    logActivity(req, "product_bulk_upsert", { count });
    res.json({ ok: true, updated: count });
  });
});

// --- REVIEWS (public) ---
app.get("/api/reviews", (req, res) => {
  const pid = Number(req.query.product_id);
  if (!Number.isFinite(pid)) return res.status(400).json({ ok: false, error: "product_id required" });
  db.all(
    `SELECT id, product_id, name, rating, text, created_at FROM product_reviews WHERE product_id = ? AND approved = 1 ORDER BY id DESC`,
    [pid],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, data: rows });
    }
  );
});

app.get("/api/reviews/latest", (req, res) => {
  const limit = Math.min(10, Math.max(1, Number(req.query.limit || 5)));
  db.all(
    `
    SELECT r.id, r.name, r.rating, r.text, r.created_at, p.name AS product_name
    FROM product_reviews r
    JOIN products p ON p.id = r.product_id
    WHERE r.approved = 1
    ORDER BY r.created_at DESC
    LIMIT ?
    `,
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, data: rows });
    }
  );
});

app.post("/api/reviews", (req, res) => {
  const { product_id, name, rating, text } = req.body || {};
  const pid = Number(product_id);
  const r = Number(rating || 5);
  if (!Number.isFinite(pid) || pid <= 0) return res.status(400).json({ ok: false, error: "Invalid product_id" });
  if (!text || String(text).trim().length < 2) return res.status(400).json({ ok: false, error: "Review text required" });
  const safeRating = Math.min(5, Math.max(1, Math.round(r)));
  const now = Date.now();
  db.run(
    `INSERT INTO product_reviews (product_id, name, rating, text, created_at, approved) VALUES (?, ?, ?, ?, ?, 1)`,
    [pid, String(name || "Anonymous").trim(), safeRating, String(text).trim(), now],
    function (err) {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, id: this.lastID, created_at: now });
    }
  );
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

  db.get(`SELECT code, type, value, active, start_at, end_at FROM promo_codes WHERE code = ? COLLATE NOCASE`, [code], (err, row) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    if (!row || !row.active) return res.status(404).json({ ok: false, error: "Invalid code" });
    const now = Date.now();
    if (row.start_at && now < row.start_at) return res.status(400).json({ ok: false, error: "Promo not started" });
    if (row.end_at && now > row.end_at) return res.status(400).json({ ok: false, error: "Promo ended" });

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
          const nowCheck = Date.now();
          if (promoRow.start_at && nowCheck < promoRow.start_at) return res.status(400).json({ ok: false, error: "Promo not started" });
          if (promoRow.end_at && nowCheck > promoRow.end_at) return res.status(400).json({ ok: false, error: "Promo ended" });
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
                db.run(
                  `INSERT INTO order_timeline (order_id, status, note, created_at, actor_id) VALUES (?, ?, ?, ?, ?)`,
                  [orderId, "PENDING", "Order placed", now, uid]
                );
                logActivity(req, "order_create", { order_id: orderId, total });
                console.log("Checkout complete", { orderId, userId: uid, total, promo, discount });
                res.json({ ok: true, order_id: orderId, subtotal, discount, total });
              });
            });
          }
        );
      };

      const code = String(promo_code || "").trim();
      if (!code) return finishCheckout(null);

      db.get(`SELECT code, type, value, active, start_at, end_at FROM promo_codes WHERE code = ? COLLATE NOCASE`, [code], (e0, row0) => {
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

app.get("/api/admin/orders/:id/timeline", requireAdmin, (req, res) => {
  const oid = Number(req.params.id);
  if (!Number.isFinite(oid)) return res.status(400).json({ ok: false, error: "Invalid id" });
  db.all(
    `SELECT id, status, note, created_at, actor_id FROM order_timeline WHERE order_id = ? ORDER BY created_at ASC`,
    [oid],
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
    const now = Date.now();
    db.run(`UPDATE orders SET updated_at = ? WHERE id = ?`, [now, oid]);
    db.run(
      `INSERT INTO order_timeline (order_id, status, note, created_at, actor_id) VALUES (?, ?, ?, ?, ?)`,
      [oid, status, "Status updated", now, req.session?.user?.id || null]
    );
    logActivity(req, "order_status_update", { order_id: oid, status });
    res.json({ ok: true, updated: this.changes });
  });
});

app.post("/api/admin/orders/bulk-status", requireAdmin, (req, res) => {
  const { ids, status } = req.body || {};
  const allowed = ["PENDING", "PAID", "SHIPPED", "DELIVERED", "CANCELLED"];
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ ok: false, error: "ids[] required" });
  const cleanIds = ids.map((id) => Number(id)).filter((id) => Number.isFinite(id));
  if (!allowed.includes(String(status || "").toUpperCase())) return res.status(400).json({ ok: false, error: "Invalid status" });
  const st = String(status).toUpperCase();
  const now = Date.now();
  db.serialize(() => {
    const stmt = db.prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE id = ?`);
    const tl = db.prepare(`INSERT INTO order_timeline (order_id, status, note, created_at, actor_id) VALUES (?, ?, ?, ?, ?)`);
    cleanIds.forEach((id) => {
      stmt.run(st, now, id);
      tl.run(id, st, "Bulk update", now, req.session?.user?.id || null);
    });
    stmt.finalize();
    tl.finalize();
    logActivity(req, "order_bulk_status", { ids: cleanIds, status: st });
    res.json({ ok: true, updated: cleanIds.length });
  });
});

// --- ADMIN: STATS ---
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = today.getTime();

  const stats = {};
  db.serialize(() => {
    db.get(`SELECT COUNT(*) AS c FROM orders`, [], (e1, r1) => {
      stats.total_orders = r1?.c || 0;
    });
    db.get(`SELECT COALESCE(SUM(total),0) AS s FROM orders`, [], (e2, r2) => {
      stats.total_revenue = r2?.s || 0;
    });
    db.get(`SELECT COUNT(*) AS c FROM orders WHERE created_at >= ?`, [start], (e3, r3) => {
      stats.today_orders = r3?.c || 0;
    });
    db.get(`SELECT COUNT(*) AS c FROM orders WHERE status = 'PENDING'`, [], (e4, r4) => {
      stats.pending_orders = r4?.c || 0;
    });
    db.get(`SELECT COUNT(*) AS c FROM products WHERE stock <= 5`, [], (e5, r5) => {
      stats.low_stock = r5?.c || 0;
    });
    db.all(
      `
      SELECT p.id, p.name, SUM(oi.qty) AS qty
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      GROUP BY p.id
      ORDER BY qty DESC
      LIMIT 5
      `,
      [],
      (e6, rows) => {
        stats.top_products = rows || [];
        res.json({ ok: true, data: stats });
      }
    );
  });
});

// --- ADMIN: USERS ---
app.get("/api/admin/users", requireAdmin, (req, res) => {
  db.all(
    `SELECT id, name, email, is_admin, is_active, role, created_at FROM users ORDER BY id DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, data: rows });
    }
  );
});

app.get("/api/admin/users/:id/orders", requireAdmin, (req, res) => {
  const uid = Number(req.params.id);
  if (!Number.isFinite(uid)) return res.status(400).json({ ok: false, error: "Invalid id" });
  db.all(
    `SELECT id, total, status, created_at FROM orders WHERE user_id = ? ORDER BY id DESC`,
    [uid],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, data: rows });
    }
  );
});

app.post("/api/admin/users/:id", requireAdminRole("admin"), (req, res) => {
  const uid = Number(req.params.id);
  if (!Number.isFinite(uid)) return res.status(400).json({ ok: false, error: "Invalid id" });
  const { is_active, is_admin, role } = req.body || {};
  const fields = [];
  const params = [];
  if (is_active !== undefined) {
    fields.push("is_active = ?");
    params.push(is_active ? 1 : 0);
  }
  if (role !== undefined) {
    const roleValue = String(role);
    fields.push("role = ?");
    params.push(roleValue);
    if (roleValue === "admin" || roleValue === "staff") {
      fields.push("is_admin = ?");
      params.push(1);
    } else if (roleValue === "customer") {
      fields.push("is_admin = ?");
      params.push(0);
    }
  } else if (is_admin !== undefined) {
    fields.push("is_admin = ?");
    params.push(is_admin ? 1 : 0);
    if (!is_admin) {
      fields.push("role = ?");
      params.push("customer");
    }
  }
  if (!fields.length) return res.status(400).json({ ok: false, error: "No changes" });
  params.push(uid);
  db.run(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, params, function (err) {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    logActivity(req, "user_update", { id: uid, fields: Object.keys(req.body || {}) });
    res.json({ ok: true, updated: this.changes });
  });
});

// --- ADMIN: PROMOS ---
app.get("/api/admin/promos", requireAdmin, (req, res) => {
  db.all(`SELECT code, type, value, active, start_at, end_at FROM promo_codes ORDER BY code ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true, data: rows });
  });
});

app.post("/api/admin/promos", requireAdminRole("admin"), (req, res) => {
  const { code, type, value, active, start_at, end_at } = req.body || {};
  const v = toNumber(value);
  if (!code || !type || v === null) return res.status(400).json({ ok: false, error: "code, type, value required" });
  db.run(
    `INSERT OR REPLACE INTO promo_codes (code, type, value, active, start_at, end_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      String(code).trim().toUpperCase(),
      String(type).trim().toUpperCase(),
      v,
      active === 0 ? 0 : 1,
      start_at ? Number(start_at) : null,
      end_at ? Number(end_at) : null
    ],
    function (err) {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      logActivity(req, "promo_save", { code: String(code).trim().toUpperCase() });
      res.json({ ok: true });
    }
  );
});

app.post("/api/admin/promos/:code/toggle", requireAdminRole("admin"), (req, res) => {
  const code = String(req.params.code || "").trim().toUpperCase();
  db.run(`UPDATE promo_codes SET active = CASE WHEN active=1 THEN 0 ELSE 1 END WHERE code = ?`, [code], function (err) {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    logActivity(req, "promo_toggle", { code });
    res.json({ ok: true, updated: this.changes });
  });
});

app.delete("/api/admin/promos/:code", requireAdminRole("admin"), (req, res) => {
  const code = String(req.params.code || "").trim().toUpperCase();
  db.run(`DELETE FROM promo_codes WHERE code = ?`, [code], function (err) {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    logActivity(req, "promo_delete", { code });
    res.json({ ok: true, deleted: this.changes });
  });
});

// --- ADMIN: SHIPPING ZONES ---
app.get("/api/admin/shipping-zones", requireAdmin, (req, res) => {
  db.all(`SELECT id, name, fee, eta_text, active FROM shipping_zones ORDER BY id ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true, data: rows });
  });
});

app.post("/api/admin/shipping-zones", requireAdminRole("admin"), (req, res) => {
  const { name, fee, eta_text, active } = req.body || {};
  const f = toNumber(fee);
  if (!name || f === null || !eta_text) return res.status(400).json({ ok: false, error: "name, fee, eta_text required" });
  db.run(
    `INSERT INTO shipping_zones (name, fee, eta_text, active) VALUES (?, ?, ?, ?)`,
    [String(name).trim(), f, String(eta_text).trim(), active === 0 ? 0 : 1],
    function (err) {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      logActivity(req, "shipping_add", { name });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

app.put("/api/admin/shipping-zones/:id", requireAdminRole("admin"), (req, res) => {
  const zid = Number(req.params.id);
  if (!Number.isFinite(zid)) return res.status(400).json({ ok: false, error: "Invalid id" });
  const { name, fee, eta_text, active } = req.body || {};
  const fields = [];
  const params = [];
  if (name !== undefined) { fields.push("name = ?"); params.push(String(name).trim()); }
  if (fee !== undefined) {
    const f = toNumber(fee);
    if (f === null) return res.status(400).json({ ok: false, error: "Invalid fee" });
    fields.push("fee = ?"); params.push(f);
  }
  if (eta_text !== undefined) { fields.push("eta_text = ?"); params.push(String(eta_text).trim()); }
  if (active !== undefined) { fields.push("active = ?"); params.push(active ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ ok: false, error: "No changes" });
  params.push(zid);
  db.run(`UPDATE shipping_zones SET ${fields.join(", ")} WHERE id = ?`, params, function (err) {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    logActivity(req, "shipping_update", { id: zid });
    res.json({ ok: true, updated: this.changes });
  });
});

app.delete("/api/admin/shipping-zones/:id", requireAdminRole("admin"), (req, res) => {
  const zid = Number(req.params.id);
  if (!Number.isFinite(zid)) return res.status(400).json({ ok: false, error: "Invalid id" });
  db.run(`DELETE FROM shipping_zones WHERE id = ?`, [zid], function (err) {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    logActivity(req, "shipping_delete", { id: zid });
    res.json({ ok: true, deleted: this.changes });
  });
});

// --- ADMIN: REVIEWS ---
app.get("/api/admin/reviews", requireAdmin, (req, res) => {
  db.all(
    `
    SELECT r.id, r.product_id, r.name, r.rating, r.text, r.created_at, r.approved, p.name AS product_name
    FROM product_reviews r
    JOIN products p ON p.id = r.product_id
    ORDER BY r.created_at DESC
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, data: rows });
    }
  );
});

app.post("/api/admin/reviews/:id", requireAdmin, (req, res) => {
  const rid = Number(req.params.id);
  if (!Number.isFinite(rid)) return res.status(400).json({ ok: false, error: "Invalid id" });
  const { approved } = req.body || {};
  db.run(`UPDATE product_reviews SET approved = ? WHERE id = ?`, [approved ? 1 : 0, rid], function (err) {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    logActivity(req, "review_update", { id: rid, approved: !!approved });
    res.json({ ok: true, updated: this.changes });
  });
});

app.delete("/api/admin/reviews/:id", requireAdmin, (req, res) => {
  const rid = Number(req.params.id);
  if (!Number.isFinite(rid)) return res.status(400).json({ ok: false, error: "Invalid id" });
  db.run(`DELETE FROM product_reviews WHERE id = ?`, [rid], function (err) {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    logActivity(req, "review_delete", { id: rid });
    res.json({ ok: true, deleted: this.changes });
  });
});

// --- ADMIN: RETURNS ---
app.get("/api/admin/returns", requireAdmin, (req, res) => {
  db.all(
    `SELECT id, order_id, reason, status, created_at FROM return_requests ORDER BY created_at DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, data: rows });
    }
  );
});

app.post("/api/admin/returns", requireAdmin, (req, res) => {
  const { order_id, reason } = req.body || {};
  const oid = Number(order_id);
  if (!Number.isFinite(oid) || !reason) return res.status(400).json({ ok: false, error: "order_id and reason required" });
  const now = Date.now();
  db.run(
    `INSERT INTO return_requests (order_id, reason, status, created_at) VALUES (?, ?, 'OPEN', ?)`,
    [oid, String(reason).trim(), now],
    function (err) {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      logActivity(req, "return_create", { id: this.lastID, order_id: oid });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

app.post("/api/admin/returns/:id/status", requireAdmin, (req, res) => {
  const rid = Number(req.params.id);
  const status = String(req.body?.status || "").trim().toUpperCase();
  const allowed = ["OPEN", "APPROVED", "DENIED", "REFUNDED", "CLOSED"];
  if (!Number.isFinite(rid)) return res.status(400).json({ ok: false, error: "Invalid id" });
  if (!allowed.includes(status)) return res.status(400).json({ ok: false, error: "Invalid status" });
  db.run(`UPDATE return_requests SET status = ? WHERE id = ?`, [status, rid], function (err) {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    logActivity(req, "return_update", { id: rid, status });
    res.json({ ok: true, updated: this.changes });
  });
});

app.delete("/api/admin/returns/:id", requireAdmin, (req, res) => {
  const rid = Number(req.params.id);
  if (!Number.isFinite(rid)) return res.status(400).json({ ok: false, error: "Invalid id" });
  db.run(`DELETE FROM return_requests WHERE id = ?`, [rid], function (err) {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    logActivity(req, "return_delete", { id: rid });
    res.json({ ok: true, deleted: this.changes });
  });
});

// --- ADMIN: ACTIVITY ---
app.get("/api/admin/activity", requireAdmin, (req, res) => {
  db.all(
    `SELECT a.id, a.action, a.meta, a.created_at, u.name AS user_name
     FROM activity_log a
     LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.created_at DESC
     LIMIT 100`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, data: rows });
    }
  );
});

// --- ADMIN: REVENUE BY CATEGORY ---
app.get("/api/admin/revenue-by-category", requireAdmin, (req, res) => {
  const days = toNumber(req.query.days);
  const now = Date.now();
  const since = Number.isFinite(days) ? now - days * 24 * 60 * 60 * 1000 : null;
  const sql = `
    SELECT p.category AS category, SUM(oi.qty * oi.price_each) AS revenue
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    JOIN orders o ON o.id = oi.order_id
    ${since ? "WHERE o.created_at >= ?" : ""}
    GROUP BY p.category
    ORDER BY revenue DESC
  `;
  db.all(sql, since ? [since] : [], (err, rows) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true, data: rows });
  });
});

// --- ADMIN: SETTINGS ---
app.get("/api/admin/settings", requireAdmin, (req, res) => {
  db.all(`SELECT key, value FROM site_settings`, [], (err, rows) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true, data: rows });
  });
});

app.post("/api/admin/settings", requireAdminRole("admin"), (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ ok: false, error: "key required" });
  db.run(
    `INSERT OR REPLACE INTO site_settings (key, value) VALUES (?, ?)`,
    [String(key), typeof value === "string" ? value : JSON.stringify(value)],
    function (err) {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      logActivity(req, "settings_update", { key });
      res.json({ ok: true });
    }
  );
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
