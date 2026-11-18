require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const {
  MPESA_ENV = 'sandbox',
  CONSUMER_KEY,
  CONSUMER_SECRET,
  STORE_NUMBER,
  TILL_NUMBER,
  PASSKEY,
  CALLBACK_BASE_URL,
  CALLBACK_SECRET,
  PORT = 3000,
} = process.env;
const required = { CONSUMER_KEY, CONSUMER_SECRET, STORE_NUMBER, TILL_NUMBER, PASSKEY, CALLBACK_BASE_URL, CALLBACK_SECRET };
for (const [k, v] of Object.entries(required)) {
  if (!v) {
    console.error(`Missing env var: ${k}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const BASE =
  MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

const app = express();
app.use(express.json());

/* ---------- In-memory store (swap for a database in production) ---------- */
// CheckoutRequestID -> { status, amount, phone, reference, receipt, resultDesc, createdAt }
const payments = new Map();

/* ---------- Helpers ---------- */
function timestamp() {
  // YYYYMMDDHHmmss in East Africa Time
  const eat = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return eat.toISOString().replace(/\D/g, '').slice(0, 14);
}

function password(ts) {
  return Buffer.from(`${STORE_NUMBER}${PASSKEY}${ts}`).toString('base64');
}

function normalizePhone(input) {
  let p = String(input || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (/^[17]\d{8}$/.test(p)) p = '254' + p;
  return /^254[17]\d{8}$/.test(p) ? p : null;
}

let tokenCache = { token: null, expiresAt: 0 };
async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const { data } = await axios.get(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
    timeout: 15000,
  });
  // Tokens last ~1 hour; refresh a minute early
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) - 60) * 1000 };
  return tokenCache.token;
}

/* ---------- Routes ---------- */

// Initiate STK Push
app.post('/api/pay', async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const amount = Math.round(Number(req.body.amount));
  const reference = String(req.body.reference || 'Payment').slice(0, 12);

  if (!phone) return res.status(400).json({ error: 'Enter a valid Safaricom number, e.g. 0712345678' });
  if (!Number.isInteger(amount) || amount < 1 || amount > 250000) {
    return res.status(400).json({ error: 'Amount must be between 1 and 250,000' });
  }

  try {
    const token = await getToken();
    const ts = timestamp();

    const { data } = await axios.post(
      `${BASE}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: STORE_NUMBER,
        Password: password(ts),
        Timestamp: ts,
        TransactionType: 'CustomerBuyGoodsOnline',
        Amount: amount,
        PartyA: phone,
        PartyB: TILL_NUMBER,
        PhoneNumber: phone,
        CallBackURL: `${CALLBACK_BASE_URL}/mpesa/callback/${CALLBACK_SECRET}`,
        AccountReference: reference,
        TransactionDesc: 'Payment',
      },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
    );

    if (data.ResponseCode !== '0') {
      return res.status(502).json({ error: data.ResponseDescription || 'STK Push was rejected' });
    }

    payments.set(data.CheckoutRequestID, {
      status: 'pending',
      amount,
      phone,
      reference,
      createdAt: Date.now(),
    });

    res.json({
      checkoutRequestId: data.CheckoutRequestID,
      message: data.CustomerMessage || 'Check your phone and enter your M-Pesa PIN',
    });
  } catch (err) {
    console.error('STK push failed:', err.response?.data || err.message);
    res.status(502).json({ error: err.response?.data?.errorMessage || 'Could not start payment. Try again.' });
  }
});

// Safaricom posts the result here
app.post('/mpesa/callback/:secret', (req, res) => {
  if (req.params.secret !== CALLBACK_SECRET) return res.sendStatus(404);

  const cb = req.body?.Body?.stkCallback;
  if (!cb) return res.sendStatus(400);

  const record = payments.get(cb.CheckoutRequestID);
  // Ignore unknown requests and duplicate deliveries
  if (record && record.status === 'pending') {
    if (cb.ResultCode === 0) {
      const meta = Object.fromEntries((cb.CallbackMetadata?.Item || []).map((i) => [i.Name, i.Value]));
      record.status = 'success';
      record.receipt = meta.MpesaReceiptNumber;
      record.paidAmount = meta.Amount;
      record.paidAt = meta.TransactionDate;
      // TODO: fulfil the order / save to your database here
      console.log(`PAID ${meta.Amount} from ${meta.PhoneNumber} receipt ${meta.MpesaReceiptNumber}`);
    } else {
      record.status = cb.ResultCode === 1032 ? 'cancelled' : 'failed';
      console.log(`Payment ${record.status}: ${cb.ResultDesc}`);
    }
    record.resultDesc = cb.ResultDesc;
  }

  // Always acknowledge with 200
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// Frontend polls this
app.get('/api/status/:id', async (req, res) => {
  const record = payments.get(req.params.id);
  if (!record) return res.status(404).json({ error: 'Unknown payment' });

  // If the callback hasn't arrived after 25s, ask Safaricom directly
  if (record.status === 'pending' && Date.now() - record.createdAt > 25000) {
    try {
      const token = await getToken();
      const ts = timestamp();
      const { data } = await axios.post(
        `${BASE}/mpesa/stkpushquery/v1/query`,
        {
          BusinessShortCode: STORE_NUMBER,
          Password: password(ts),
          Timestamp: ts,
          CheckoutRequestID: req.params.id,
        },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );
      if (data.ResultCode !== undefined && record.status === 'pending') {
        const code = Number(data.ResultCode);
        record.status = code === 0 ? 'success' : code === 1032 ? 'cancelled' : 'failed';
        record.resultDesc = data.ResultDesc;
      }
    } catch (_) {
      // "Request is being processed" comes back as an error: stay pending
    }
  }

  res.json({
    status: record.status,
    amount: record.amount,
    receipt: record.receipt || null,
    message: record.resultDesc || null,
  });
});

// Payment page
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.css', (_req, res) => res.sendFile(path.join(__dirname, 'index.css')));

app.listen(PORT, () => console.log(`Server on http://localhost:${PORT} (${MPESA_ENV})`));