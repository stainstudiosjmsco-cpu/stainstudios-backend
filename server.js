const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '25mb' }));

// ── PERSISTENT STORAGE ──
// Render's free disk is wiped on every redeploy, so site photos, products, and
// customer carts previously vanished whenever the backend redeployed. This uses
// Firebase Realtime Database (free, reliable) as the permanent store. Local
// files are kept as a fast fallback cache only.
const FIREBASE_URL = (process.env.FIREBASE_DB_URL || '').replace(/\/$/, ''); // strip trailing slash

const PHOTOS_FILE = path.join(__dirname, 'site-photos.json');
const PRODUCTS_FILE = path.join(__dirname, 'products.json');
const CARTS_FILE = path.join(__dirname, 'carts.json');
const REVIEWS_FILE = path.join(__dirname, 'reviews.json');
const SHIPPED_ORDERS_FILE = path.join(__dirname, 'shipped-orders.json');

function firebaseRequest(method, key, payload, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!FIREBASE_URL) return resolve({ ok: false, data: null, error: 'No FIREBASE_DB_URL configured' });
    const url = `${FIREBASE_URL}/${key}.json`;
    const data = payload !== undefined ? JSON.stringify(payload) : null;
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ ok: false, data: null, error: 'Invalid Firebase URL' }); }
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
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        try { resolve({ ok, data: JSON.parse(body), error: ok ? null : `Firebase returned ${res.statusCode}: ${body.slice(0,200)}` }); }
        catch (e) { resolve({ ok, data: null, error: ok ? null : `Firebase returned ${res.statusCode}: ${body.slice(0,200)}` }); }
      });
    });

    req.on('error', (err) => resolve({ ok: false, data: null, error: err.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, data: null, error: 'Firebase request timed out' }); });

    if (data) req.write(data);
    req.end();
  });
}

async function loadPhotos() {
  const remote = await firebaseRequest('GET', 'sitePhotos');
  if (remote.ok && remote.data) { try { fs.writeFileSync(PHOTOS_FILE, JSON.stringify(remote.data)); } catch(e){} return remote.data; }
  try { return JSON.parse(fs.readFileSync(PHOTOS_FILE, 'utf8')); }
  catch (e) { return { hero: '', banner: '', editorial: '', about: '' }; }
}

async function savePhotos(data) {
  try { fs.writeFileSync(PHOTOS_FILE, JSON.stringify(data, null, 2)); } catch(e){}
  const result = await firebaseRequest('PUT', 'sitePhotos', data);
  if (!result.ok) console.error('Failed to save photos to Firebase:', result.error);
  return result;
}

async function loadProducts() {
  const remote = await firebaseRequest('GET', 'products');
  if (remote.ok && remote.data) { try { fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(remote.data)); } catch(e){} return remote.data; }
  try { return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8')); }
  catch (e) { return []; }
}

async function saveProductsFile(data) {
  try { fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(data, null, 2)); } catch(e){}
  const result = await firebaseRequest('PUT', 'products', data);
  if (!result.ok) console.error('Failed to save products to Firebase:', result.error);
  return result;
}

async function loadReviews() {
  const remote = await firebaseRequest('GET', 'reviews');
  if (remote.ok && remote.data) { try { fs.writeFileSync(REVIEWS_FILE, JSON.stringify(remote.data)); } catch(e){} return remote.data; }
  try { return JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8')); }
  catch (e) { return {}; }
}

async function saveReviews(data) {
  try { fs.writeFileSync(REVIEWS_FILE, JSON.stringify(data, null, 2)); } catch(e){}
  const result = await firebaseRequest('PUT', 'reviews', data);
  if (!result.ok) console.error('Failed to save reviews to Firebase:', result.error);
  return result;
}

async function loadShippedOrders() {
  const remote = await firebaseRequest('GET', 'shippedOrders');
  if (remote.ok && remote.data) { try { fs.writeFileSync(SHIPPED_ORDERS_FILE, JSON.stringify(remote.data)); } catch(e){} return remote.data; }
  try { return JSON.parse(fs.readFileSync(SHIPPED_ORDERS_FILE, 'utf8')); }
  catch (e) { return {}; }
}

async function saveShippedOrders(data) {
  try { fs.writeFileSync(SHIPPED_ORDERS_FILE, JSON.stringify(data, null, 2)); } catch(e){}
  const result = await firebaseRequest('PUT', 'shippedOrders', data);
  if (!result.ok) console.error('Failed to save shipped orders to Firebase:', result.error);
  return result;
}

async function loadCarts() {
  const remote = await firebaseRequest('GET', 'carts');
  if (remote.ok && remote.data) { try { fs.writeFileSync(CARTS_FILE, JSON.stringify(remote.data)); } catch(e){} return remote.data; }
  try { return JSON.parse(fs.readFileSync(CARTS_FILE, 'utf8')); }
  catch (e) { return {}; }
}

async function saveCarts(data) {
  try { fs.writeFileSync(CARTS_FILE, JSON.stringify(data, null, 2)); } catch(e){}
  const result = await firebaseRequest('PUT', 'carts', data);
  if (!result.ok) console.error('Failed to save carts to Firebase:', result.error);
  return result;
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
    const allowed = ['hero', 'banner', 'editorial', 'about', 'editorialEyebrow', 'editorialTitle', 'editorialBody', 'collections', 'linkPreview'];
    if (!allowed.includes(key)) {
      return res.status(400).json({ error: 'Invalid photo key' });
    }
    const photos = await loadPhotos();
    photos[key] = url || '';
    const result = await savePhotos(photos);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Could not save to persistent storage' });
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
    const result = await saveProductsFile(products);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Could not save to persistent storage — product was not saved' });
    res.json({ success: true, product });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Reorder products — called by admin.html when the site owner drags/moves products to change display order
app.put('/products/reorder', async (req, res) => {
  try {
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array' });
    const products = await loadProducts();
    const byId = new Map(products.map(p => [p.id, p]));
    const reordered = orderedIds.map(id => byId.get(id)).filter(Boolean);
    // Include any products not listed (safety net) at the end, preserving their relative order
    products.forEach(p => { if (!orderedIds.includes(p.id)) reordered.push(p); });
    const result = await saveProductsFile(reordered);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Could not save new order to persistent storage' });
    res.json({ success: true, products: reordered });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Decrement stock after a completed order — called by index.html right after
// a successful payment (card, Apple/Google Pay, or PayPal), so stock stays
// accurate without needing to manually update it in the admin panel.
app.post('/products/decrement-stock', async (req, res) => {
  try {
    const { items } = req.body; // [{ productId, size, qty }]
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array is required' });
    const products = await loadProducts();
    items.forEach(({ productId, size, qty }) => {
      const product = products.find(p => p.id === productId);
      if (product && product.stock && typeof product.stock[size] === 'number') {
        product.stock[size] = Math.max(0, product.stock[size] - (parseInt(qty) || 0));
      }
    });
    const result = await saveProductsFile(products);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Could not save updated stock to persistent storage' });
    res.json({ success: true, products });
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
    const result = await saveProductsFile(products);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Could not save to persistent storage' });
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
    const result = await saveProductsFile(products);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Could not save to persistent storage' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get ALL reviews for ALL products in one call — used by index.html on page load
// so it doesn't need to make a separate request per product (much faster).
app.get('/reviews', async (req, res) => {
  try {
    const allReviews = await loadReviews();
    res.json({ reviews: allReviews });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get all reviews for a product — called by index.html when opening a product / reviews popup
app.get('/reviews/:productId', async (req, res) => {
  try {
    const productId = req.params.productId;
    const allReviews = await loadReviews();
    res.json({ reviews: allReviews[productId] || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Submit a new review for a product — called by index.html "Write a Review" form
app.post('/reviews/:productId', async (req, res) => {
  try {
    const productId = req.params.productId;
    const { name, rating, comment } = req.body;
    const ratingNum = parseInt(rating);
    if (!name || !comment || !ratingNum || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ error: 'Name, comment, and a rating from 1-5 are required.' });
    }
    const allReviews = await loadReviews();
    if (!Array.isArray(allReviews[productId])) allReviews[productId] = [];
    const review = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      name: name.trim(),
      rating: ratingNum,
      comment: comment.trim(),
      date: new Date().toLocaleDateString()
    };
    allReviews[productId].unshift(review);
    const result = await saveReviews(allReviews);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Could not save review to persistent storage' });
    res.json({ success: true, reviews: allReviews[productId] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a single review — called by admin.html Reviews tab
app.delete('/reviews/:productId/:reviewId', async (req, res) => {
  try {
    const { productId, reviewId } = req.params;
    const allReviews = await loadReviews();
    if (!Array.isArray(allReviews[productId])) return res.status(404).json({ error: 'No reviews found for this product' });
    allReviews[productId] = allReviews[productId].filter(r => r.id !== reviewId);
    const result = await saveReviews(allReviews);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Could not save to persistent storage' });
    res.json({ success: true, reviews: allReviews[productId] });
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
    const result = await saveCarts(carts);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Could not save to persistent storage' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Formspree form ID, taken from your form URL: https://formspree.io/f/xredkvqz
const FORMSPREE_FORM_ID = 'xredkvqz';

function formspreeRequest(path) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'formspree.io',
      path: path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${process.env.FORMSPREE_API_KEY || ''}` }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        try { resolve({ ok, data: JSON.parse(body), error: ok ? null : `Formspree returned ${res.statusCode}: ${body.slice(0,300)}` }); }
        catch (e) { resolve({ ok, data: null, error: ok ? null : `Formspree returned ${res.statusCode}: ${body.slice(0,300)}` }); }
      });
    });
    req.on('error', (err) => resolve({ ok: false, data: null, error: err.message }));
    req.end();
  });
}

// Get recent orders — called by admin.html's Orders tab, pulls straight from
// your Formspree submissions so you don't have to type orders in by hand.
app.get('/orders', async (req, res) => {
  if (!process.env.FORMSPREE_API_KEY) {
    return res.status(500).json({ error: "FORMSPREE_API_KEY isn't set on the server. In Formspree, go to your form's Settings > enable 'HTTP API' to get a key, then add it as an environment variable named FORMSPREE_API_KEY in Render." });
  }
  const result = await formspreeRequest(`/api/0/forms/${FORMSPREE_FORM_ID}/submissions?limit=100`);
  if (!result.ok) return res.status(500).json({ error: result.error || 'Could not fetch orders from Formspree' });
  res.json(result.data);
});

// Get which orders have been marked shipped — called by admin.html Orders tab
app.get('/orders/shipped', async (req, res) => {
  try {
    const shipped = await loadShippedOrders();
    res.json({ shipped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Mark an order shipped/unshipped — orderKey is the order's unique _date
// timestamp from Formspree, since Formspree submissions don't expose an id.
app.post('/orders/shipped', async (req, res) => {
  try {
    const { orderKey, shipped } = req.body;
    if (!orderKey) return res.status(400).json({ error: 'orderKey is required' });
    const shippedOrders = await loadShippedOrders();
    if (shipped) shippedOrders[orderKey] = true;
    else delete shippedOrders[orderKey];
    const result = await saveShippedOrders(shippedOrders);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Could not save to persistent storage' });
    res.json({ success: true, shipped: shippedOrders });
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
