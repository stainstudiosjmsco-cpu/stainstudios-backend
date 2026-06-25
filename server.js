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
