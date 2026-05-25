const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const https = require('https');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Stain Studios backend is running.');
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

app.post('/send-shipping', async (req, res) => {
  try {
    const { email, first_name, tracking_number, tracking_url, order_items } = req.body;

    // Use Klaviyo v1 track endpoint — simpler and more reliable
    const payload = JSON.stringify({
      token: process.env.KLAVIYO_PUBLIC_KEY || 'Ri2utB',
      event: 'Order Shipped',
      customer_properties: {
        '$email': email,
        '$first_name': first_name
      },
      properties: {
        tracking_number: tracking_number,
        tracking_url: tracking_url,
        order_items: order_items || '',
        first_name: first_name
      }
    });

    const encoded = Buffer.from(payload).toString('base64');
    const path = `/api/track?data=${encoded}`;

    const options = {
      hostname: 'a.klaviyo.com',
      path: path,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    };

    const klaviyoReq = https.request(options, (klaviyoRes) => {
      let data = '';
      klaviyoRes.on('data', chunk => data += chunk);
      klaviyoRes.on('end', () => {
        console.log('Klaviyo response:', klaviyoRes.statusCode, data);
        if(data === '1' || klaviyoRes.statusCode === 200){
          res.json({ success: true });
        } else {
          res.status(400).json({ error: data });
        }
      });
    });

    klaviyoReq.on('error', err => res.status(500).json({ error: err.message }));
    klaviyoReq.end();

  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
