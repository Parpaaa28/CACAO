const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const DB_PATH = path.join(__dirname, "app.db");

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("Failed to open DB:", err.message);
    process.exit(1);
  }
  console.log("SQLite DB ready:", DB_PATH);
});

function ensureColumn(table, column, def, cb) {
  db.all(`PRAGMA table_info(${table})`, [], (err, rows) => {
    if (err) return cb && cb(err);
    const exists = rows.some((r) => r.name === column);
    if (exists) return cb && cb();
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`, cb);
  });
}

function ensureColumns(list, done) {
  if (!list.length) return done && done();
  const [head, ...rest] = list;
  ensureColumn(head.table, head.column, head.def, (err) => {
    if (err) console.error("Column ensure failed:", head, err.message);
    ensureColumns(rest, done);
  });
}

db.serialize(() => {
  // notes (existing)
  db.run(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  // users
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);

  // products
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      description TEXT,
      image_url TEXT,
      stock INTEGER NOT NULL DEFAULT 0,
      category TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  // cart items (per user)
  db.run(`
    CREATE TABLE IF NOT EXISTS cart_items (
      user_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      qty INTEGER NOT NULL,
      PRIMARY KEY (user_id, product_id)
    )
  `);

  // wishlist items
  db.run(`
    CREATE TABLE IF NOT EXISTS wishlist_items (
      user_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, product_id)
    )
  `);

  // promo codes
  db.run(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      code TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      value REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    )
  `);

  // orders
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      total REAL NOT NULL,
      status TEXT NOT NULL,
      promo_code TEXT,
      discount REAL NOT NULL DEFAULT 0,
      shipping_name TEXT,
      shipping_address TEXT,
      shipping_phone TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  // order items
  db.run(`
    CREATE TABLE IF NOT EXISTS order_items (
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      qty INTEGER NOT NULL,
      price_each REAL NOT NULL
    )
  `);

  // ensure columns on existing tables before any seed/insert
  ensureColumns(
    [
      { table: "users", column: "is_admin", def: "INTEGER NOT NULL DEFAULT 0" },
      { table: "products", column: "description", def: "TEXT" },
      { table: "products", column: "image_url", def: "TEXT" },
      { table: "products", column: "stock", def: "INTEGER NOT NULL DEFAULT 0" },
      { table: "products", column: "category", def: "TEXT" },
      { table: "orders", column: "promo_code", def: "TEXT" },
      { table: "orders", column: "discount", def: "REAL NOT NULL DEFAULT 0" },
      { table: "orders", column: "shipping_name", def: "TEXT" },
      { table: "orders", column: "shipping_address", def: "TEXT" },
      { table: "orders", column: "shipping_phone", def: "TEXT" }
    ],
    () => {
      const now = Date.now();
      const placeholderImage = "/assets/cacao-placeholder.svg";
      db.run(
        `UPDATE products SET name = ?, description = ? WHERE name = ?`,
        ["Fresh Cacao Beans 500g", "Fresh cacao beans, lightly cleaned and sorted.", "Raw Cacao Beans 500g"]
      );
      db.run(`DELETE FROM products WHERE name = ?`, ["Sun-Dried Cacao Beans 500g"]);
      db.run(
        `DELETE FROM products
         WHERE name = ?
         AND id NOT IN (SELECT MIN(id) FROM products WHERE name = ?)`,
        ["Fermented Cacao Beans 1kg", "Fermented Cacao Beans 1kg"]
      );
      const imageUpdates = [
        ["Single-Origin Cacao Beans (Bukidnon) 1kg", "/assets/beans-bukidnon-1kg.jpg"],
        ["Single-Origin Cacao Beans (Davao) 1kg", "/assets/beans-davao-1kg.jpg"],
        ["Fresh Cacao Beans 500g", "/assets/fresh-cacao-beans-500g.jpg"],
        ["Fermented Cacao Beans 1kg", "/assets/fermented-cacao-beans-1kg.jpg"],
        ["Cacao Nibs 200g", "/assets/cacao-nibs-200g.jpg"],
        ["Cacao Mass (Liquor) 250g", "/assets/cacao-mass-250g.jpg"],
        ["Natural Cocoa Powder 250g", "/assets/natural-cocoa-powder-250g.jpg"],
        ["Alkalized Cocoa Powder 250g", "/assets/alkalized-cocoa-powder-250g.jpg"],
        ["Baking Chocolate 60% 200g", "/assets/baking-chocolate-60-200g.jpg"],
        ["Chocolate Chips 250g", "/assets/chocolate-chips-250g.jpg"],
        ["Food-Grade Cacao Butter 250g", "/assets/cacao-butter-foodgrade-250g.jpg"],
        ["Deodorized Cacao Butter 500g", "/assets/cacao-butter-deodorized-500g.jpg"],
        ["Dark Chocolate Bar 70% 50g", "/assets/dark-chocolate-70-50g.jpg"],
        ["Milk Chocolate Bar 50g", "/assets/milk-chocolate-50g.jpg"],
        ["Cacao Truffles Box (9pcs)", "/assets/cacao-truffles-9pcs.jpg"],
        ["Bean-to-Bar Sampler (4pcs)", "/assets/bean-to-bar-sampler-4pcs.jpg"],
        ["Cacao Drink Mix", "/assets/cacao-drink-mix.jpg"],
        ["Hot Chocolate Sticks (6pcs)", "/assets/hot-chocolate-sticks-6pcs.jpg"],
        ["Cacao Granola 400g", "/assets/cacao-granola-400g.jpg"],
        ["Cacao Spread 200g", "/assets/cacao-spread-200g.jpg"],
        ["Ceremonial Cacao 500g", "/assets/ceremonial-cacao-500g.jpg"],
        ["Cacao Husk Tea 200g", "/assets/cacao-husk-tea-200g.jpg"],
        ["Cacao Protein Blend 500g", "/assets/cacao-protein-blend-500g.jpg"],
        ["Cacao Roasting Guidebook", "/assets/cacao-roasting-guidebook.jpg"],
        ["Manual Cacao Grinder", "/assets/manual-cacao-grinder.jpg"],
        ["Chocolate Mold Set", "/assets/chocolate-mold-set.jpg"],
        ["Cacao Sampler Bundle", "/assets/cacao-sampler-bundle.jpg"],
        ["Chocolate Lovers Gift Box", "/assets/chocolate-lovers-gift-box.jpg"]
      ];
      imageUpdates.forEach(([name, url]) => {
        db.run(`UPDATE products SET image_url = ? WHERE name = ?`, [url, name]);
      });
      const categoryUpdates = [
        ["Natural Cocoa Powder 250g", "Baking & Pastry"],
        ["Alkalized Cocoa Powder 250g", "Baking & Pastry"],
        ["Cacao Drink Mix", "Drinks & Mixes"],
        ["Dark Chocolate Bar 70% 50g", "Snacks & Bars"],
        ["Milk Chocolate Bar 50g", "Snacks & Bars"]
      ];
      categoryUpdates.forEach(([name, category]) => {
        db.run(`UPDATE products SET category = ? WHERE name = ?`, [category, name]);
      });
      const cacaoProducts = [
        { name: "Single-Origin Cacao Beans (Bukidnon) 1kg", price: 349.0, description: "Single-origin beans with fruity notes.", image_url: "/assets/beans-bukidnon-1kg.jpg", stock: 14, category: "Farm & Origin" },
        { name: "Single-Origin Cacao Beans (Davao) 1kg", price: 349.0, description: "Deep cacao flavor with nutty finish.", image_url: "/assets/beans-davao-1kg.jpg", stock: 14, category: "Farm & Origin" },
        { name: "Fresh Cacao Beans 500g", price: 169.0, description: "Fresh cacao beans, lightly cleaned and sorted.", image_url: "/assets/fresh-cacao-beans-500g.jpg", stock: 25, category: "Raw & Fermented Cacao" },
        { name: "Fermented Cacao Beans 1kg", price: 329.0, description: "Fermented beans for richer aroma.", image_url: "/assets/fermented-cacao-beans-1kg.jpg", stock: 15, category: "Raw & Fermented Cacao" },

        { name: "Cacao Nibs 200g", price: 179.0, description: "Crunchy cacao nibs for toppings.", image_url: "/assets/cacao-nibs-200g.jpg", stock: 20, category: "Cacao Derivatives" },
        { name: "Cacao Mass (Liquor) 250g", price: 249.0, description: "Pure cacao paste for recipes.", image_url: "/assets/cacao-mass-250g.jpg", stock: 14, category: "Cacao Derivatives" },
        { name: "Natural Cocoa Powder 250g", price: 149.0, description: "Natural cocoa powder for baking.", image_url: "/assets/natural-cocoa-powder-250g.jpg", stock: 30, category: "Baking & Pastry" },
        { name: "Alkalized Cocoa Powder 250g", price: 169.0, description: "Dutch-process cocoa for smooth flavor.", image_url: "/assets/alkalized-cocoa-powder-250g.jpg", stock: 22, category: "Baking & Pastry" },
        { name: "Baking Chocolate 60% 200g", price: 189.0, description: "Baking chocolate for desserts.", image_url: "/assets/baking-chocolate-60-200g.jpg", stock: 16, category: "Baking & Pastry" },
        { name: "Chocolate Chips 250g", price: 139.0, description: "Chocolate chips for cookies.", image_url: "/assets/chocolate-chips-250g.jpg", stock: 28, category: "Baking & Pastry" },

        { name: "Food-Grade Cacao Butter 250g", price: 219.0, description: "Edible cacao butter for cooking.", image_url: "/assets/cacao-butter-foodgrade-250g.jpg", stock: 12, category: "Cacao Butter & Oils" },
        { name: "Deodorized Cacao Butter 500g", price: 399.0, description: "Neutral-scent cacao butter.", image_url: "/assets/cacao-butter-deodorized-500g.jpg", stock: 10, category: "Cacao Butter & Oils" },

        { name: "Dark Chocolate Bar 70% 50g", price: 99.0, description: "70% dark chocolate bar.", image_url: "/assets/dark-chocolate-70-50g.jpg", stock: 35, category: "Snacks & Bars" },
        { name: "Milk Chocolate Bar 50g", price: 89.0, description: "Creamy milk chocolate bar.", image_url: "/assets/milk-chocolate-50g.jpg", stock: 40, category: "Snacks & Bars" },
        { name: "Cacao Truffles Box (9pcs)", price: 249.0, description: "Assorted cacao truffles.", image_url: "/assets/cacao-truffles-9pcs.jpg", stock: 12, category: "Chocolate & Confections" },
        { name: "Bean-to-Bar Sampler (4pcs)", price: 299.0, description: "Curated bean-to-bar sampler.", image_url: "/assets/bean-to-bar-sampler-4pcs.jpg", stock: 10, category: "Chocolate & Confections" },

        { name: "Cacao Drink Mix", price: 129.0, description: "Instant cacao drink mix.", image_url: "/assets/cacao-drink-mix.jpg", stock: 24, category: "Drinks & Mixes" },
        { name: "Hot Chocolate Sticks (6pcs)", price: 159.0, description: "Stir-in hot chocolate sticks.", image_url: "/assets/hot-chocolate-sticks-6pcs.jpg", stock: 18, category: "Drinks & Mixes" },
        { name: "Cacao Granola 400g", price: 199.0, description: "Cacao granola for breakfast.", image_url: "/assets/cacao-granola-400g.jpg", stock: 14, category: "Food & Beverages" },
        { name: "Cacao Spread 200g", price: 179.0, description: "Creamy cacao spread.", image_url: "/assets/cacao-spread-200g.jpg", stock: 16, category: "Food & Beverages" },

        { name: "Ceremonial Cacao 500g", price: 399.0, description: "Premium ceremonial grade cacao.", image_url: "/assets/ceremonial-cacao-500g.jpg", stock: 8, category: "Wellness & Ritual" },
        { name: "Cacao Husk Tea 200g", price: 129.0, description: "Aromatic cacao husk tea.", image_url: "/assets/cacao-husk-tea-200g.jpg", stock: 20, category: "Wellness & Ritual" },
        { name: "Cacao Protein Blend 500g", price: 349.0, description: "Protein blend with cacao.", image_url: "/assets/cacao-protein-blend-500g.jpg", stock: 10, category: "Wellness & Ritual" },

        { name: "Cacao Roasting Guidebook", price: 149.0, description: "Beginner guide to roasting cacao.", image_url: "/assets/cacao-roasting-guidebook.jpg", stock: 20, category: "Roasting & Craft" },
        { name: "Manual Cacao Grinder", price: 899.0, description: "Hand grinder for cacao beans.", image_url: "/assets/manual-cacao-grinder.jpg", stock: 5, category: "Tools & Equipment" },
        { name: "Chocolate Mold Set", price: 229.0, description: "Silicone molds for chocolate.", image_url: "/assets/chocolate-mold-set.jpg", stock: 12, category: "Tools & Equipment" },

        { name: "Cacao Sampler Bundle", price: 499.0, description: "Bundle of best-selling cacao items.", image_url: "/assets/cacao-sampler-bundle.jpg", stock: 8, category: "Gifts & Bundles" },
        { name: "Chocolate Lovers Gift Box", price: 599.0, description: "Gift box for chocolate lovers.", image_url: "/assets/chocolate-lovers-gift-box.jpg", stock: 6, category: "Gifts & Bundles" }
      ];

      function upsertProduct(p) {
        db.run(
          `
          INSERT INTO products (name, price, description, image_url, stock, category, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM products WHERE name = ?)
          `,
          [p.name, p.price, p.description, p.image_url, p.stock, p.category, now, p.name]
        );

        db.run(
          `
          UPDATE products
          SET category = COALESCE(NULLIF(category, ''), ?),
              description = COALESCE(NULLIF(description, ''), ?),
              image_url = COALESCE(NULLIF(image_url, ''), ?)
          WHERE name = ?
          `,
          [p.category, p.description, p.image_url, p.name]
        );
      }

      cacaoProducts.forEach(upsertProduct);
      console.log("Ensured cacao products and categories.");

      // ensure promo codes exist (insert or update)
      const promoCodes = [
        { code: "SAVE10", type: "PERCENT", value: 10 },
        { code: "LESS50", type: "FIXED", value: 50 },
        { code: "ARAYMOPAKAK", type: "PERCENT", value: 15 }
      ];
      promoCodes.forEach((p) => {
        db.run(
          `INSERT OR IGNORE INTO promo_codes (code, type, value, active) VALUES (?, ?, ?, ?)`,
          [p.code, p.type, p.value, 1]
        );
        db.run(
          `UPDATE promo_codes SET type = ?, value = ?, active = 1 WHERE code = ?`,
          [p.type, p.value, p.code]
        );
      });
    }
  );
});

module.exports = db;
