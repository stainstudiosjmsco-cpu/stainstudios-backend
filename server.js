const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── PERSISTENT STORAGE ──
// Render's free disk is wiped on every redeploy, so site photos, products, and
// customer carts previously vanished whenever the backend redeployed. This uses
// npoint.io (free, no signup) as a tiny persistent JSON store that survives
// redeploys, so nothing gets wiped anymore. Local files are kept as a fast
// fallback cache only.
const NPOINT_PHOTOS = process.env.NPOINT_PHOTOS_URL || '';
const NPOINT_PRODUCTS = process.env.NPOINT_PRODUCTS_URL || '';
const NPOINT_CARTS = process.env.NPOINT_CARTS_URL || '';

const PHOTOS_FILE = path.join(__dirname, 'site-photos.json');
const PRODUCTS_FILE = path.join(__dirname, 'products.json');
const CARTS_FILE = path.join(__dirname, 'carts.json');

function httpJsonRequest(method, url, payload) {
  return new Promise((resolve, reject) => {
    if (!url) return resolve(null);
    const data = payload ? JSON.stringify(payload) : null;
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    if (data) req.write(data);
    req.end();
  });
}

async function loadPhotos() {
  const remote = await httpJsonRequest('GET', NPOINT_PHOTOS);
  if (remote) { try { fs.writeFileSync(PHOTOS_FILE, JSON.stringify(remote)); } catch(e){} return remote; }
  try { return JSON.parse(fs.readFileSync(PHOTOS_FILE, 'utf8')); }
  catch (e) { return { hero: '', banner: '', editorial: '', about: '' }; }
}

async function savePhotos(data) {
  try { fs.writeFileSync(PHOTOS_FILE, JSON.stringify(data, null, 2)); } catch(e){}
  await httpJsonRequest('POST', NPOINT_PHOTOS, data);
}

async function loadProducts() {
  const remote = await httpJsonRequest('GET', NPOINT_PRODUCTS);
  if (remote) { try { fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(remote)); } catch(e){} return remote; }
  try { return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8')); }
  catch (e) { return []; }
}

async function saveProductsFile(data) {
  try { fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(data, null, 2)); } catch(e){}
  await httpJsonRequest('POST', NPOINT_PRODUCTS, data);
}

async function loadCarts() {
  const remote = await httpJsonRequest('GET', NPOINT_CARTS);
  if (remote) { try { fs.writeFileSync(CARTS_FILE, JSON.stringify(remote)); } catch(e){} return remote; }
  try { return JSON.parse(fs.readFileSync(CARTS_FILE, 'utf8')); }
  catch (e) { return {}; }
}

async function saveCarts(data) {
  try { fs.writeFileSync(CARTS_FILE, JSON.stringify(data, null, 2)); } catch(e){}
  await httpJsonRequest('POST', NPOINT_CARTS, data);
}

app.get('/', (req, res) => {
  res.send('Stain Studios backend is running.');
});

// Get current site photos — called by index.html on page load
app.get('/site-photos', async (req, res) => {
  res.json(await loadPhotos());
});

// Update a site photo — called by admin.html
app.post('/site-photos', async (req, res) => {
  try {
    const { key, url } = req.body;
    const allowed = ['hero', 'banner', 'editorial', 'about'];
    if (!allowed.includes(key)) {
      return res.status(400).json({ error: 'Invalid photo key' });
    }
    const photos = await loadPhotos();
    photos[key] = url || '';
    await savePhotos(photos);
    res.json({ success: true, photos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get all products — called by index.html on page load
app.get('/products', async (req, res) => {
  res.json(await loadProducts());
});

// Add a new product — called by admin.html
app.post('/products', async (req, res) => {
  try {
    const product = req.body;
    const products = await loadProducts();
    product.id = Date.now();
    product.addedAt = new Date().toLocaleDateString();
    products.unshift(product);
    await saveProductsFile(products);
    res.json({ success: true, product });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Update an existing product — called by admin.html
app.put('/products/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const updates = req.body;
    let products = await loadProducts();
    const idx = products.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Product not found' });
    products[idx] = { ...products[idx], ...updates, id };
    await saveProductsFile(products);
    res.json({ success: true, product: products[idx] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a product — called by admin.html
app.delete('/products/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    let products = await loadProducts();
    products = products.filter(p => p.id !== id);
    await saveProductsFile(products);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get a customer's saved cart by email — called by index.html on login
app.get('/cart/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const carts = await loadCarts();
    res.json({ cart: carts[email] || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Save a customer's cart by email — called by index.html whenever the cart changes
app.post('/cart/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const { cart } = req.body;
    const carts = await loadCarts();
    carts[email] = cart || [];
    await saveCarts(carts);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, email, name, address } = req.body;
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      receipt_email: email,
      description: 'Stain Studios Order',
      shipping: {
        name: name,
        address: { line1: address, country: 'US' },
      },
      automatic_payment_methods: { enabled: true },
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Helper to make Klaviyo API calls
function klaviyoRequest(method, path, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : null;
    const options = {
      hostname: 'a.klaviyo.com',
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Klaviyo-API-Key ${process.env.KLAVIYO_PRIVATE_KEY}`,
        'revision': '2023-10-15',
      }
    };
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

app.post('/send-shipping', async (req, res) => {
  try {
    const { email, first_name, tracking_number, tracking_url, order_items } = req.body;

    // Step 1: Create or update the profile in Klaviyo
    const profilePayload = {
      data: {
        type: 'profile',
        attributes: {
          email: email,
          first_name: first_name
        }
      }
    };
    const profileRes = await klaviyoRequest('POST', '/api/profiles/', profilePayload);
    console.log('Profile response:', profileRes.status, profileRes.body);

    // Get profile ID from response or conflict response
    let profileId = null;
    try {
      const profileData = JSON.parse(profileRes.body);
      if (profileRes.status === 201) {
        profileId = profileData.data.id;
      } else if (profileRes.status === 409) {
        // Profile already exists
        profileId = profileData.errors[0].meta.duplicate_profile_id;
      }
    } catch(e) { console.log('Profile parse error', e); }

    console.log('Profile ID:', profileId);

    // Step 2: Send the Order Shipped event
    const eventPayload = {
      data: {
        type: 'event',
        attributes: {
          metric: {
            data: {
              type: 'metric',
              attributes: { name: 'Order Shipped' }
            }
          },
          profile: {
            data: {
              type: 'profile',
              attributes: {
                email: email,
                first_name: first_name
              }
            }
          },
          properties: {
            tracking_number: tracking_number,
            tracking_url: tracking_url,
            order_items: order_items || '',
            first_name: first_name
          },
          value: 0
        }
      }
    };

    const eventRes = await klaviyoRequest('POST', '/api/events/', eventPayload);
    console.log('Event response:', eventRes.status, eventRes.body);

    if (eventRes.status === 202 || eventRes.status === 200 || eventRes.status === 201) {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: eventRes.body });
    }

  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/send-order-confirmation', async (req, res) => {
  try {
    const { email, first_name, order_items, order_total } = req.body;

    const eventPayload = {
      data: {
        type: 'event',
        attributes: {
          metric: {
            data: {
              type: 'metric',
              attributes: { name: 'Placed Order' }
            }
          },
          profile: {
            data: {
              type: 'profile',
              attributes: {
                email: email,
                first_name: first_name
              }
            }
          },
          properties: {
            first_name: first_name,
            order_items: order_items || '',
            order_total: order_total || '',
            estimated_delivery: '8–12 business days'
          },
          value: 0
        }
      }
    };

    const eventRes = await klaviyoRequest('POST', '/api/events/', eventPayload);
    console.log('Order confirmation event:', eventRes.status, eventRes.body);

    if(eventRes.status === 202 || eventRes.status === 200 || eventRes.status === 201){
      res.json({ success: true });
    } else {
      res.status(400).json({ error: eventRes.body });
    }
  } catch(err){
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
