const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const https = require('https');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.send('Stain Studios backend is running.');
});

// Create payment intent
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

// Send shipping notification via Klaviyo
app.post('/send-shipping', async (req, res) => {
  try {
    const { email, first_name, tracking_number, tracking_url, order_items } = req.body;

    const payload = JSON.stringify({
      data: {
        type: 'event',
        attributes: {
          metric: { data: { type: 'metric', attributes: { name: 'Order Shipped' } } },
          profile: { data: { type: 'profile', attributes: { email, first_name } } },
          properties: { tracking_number, tracking_url, order_items: order_items || '', first_name }
        }
      }
    });

    const options = {
      hostname: 'a.klaviyo.com',
      path: '/api/events/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Klaviyo-API-Key ${process.env.KLAVIYO_PRIVATE_KEY}`,
        'revision': '2023-02-22',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const klaviyoReq = https.request(options, (klaviyoRes) => {
      let data = '';
      klaviyoRes.on('data', chunk => data += chunk);
      klaviyoRes.on('end', () => {
        if(klaviyoRes.statusCode === 202 || klaviyoRes.statusCode === 200){
          res.json({ success: true });
        } else {
          res.status(400).json({ error: data });
        }
      });
    });

    klaviyoReq.on('error', err => res.status(500).json({ error: err.message }));
    klaviyoReq.write(payload);
    klaviyoReq.end();

  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
